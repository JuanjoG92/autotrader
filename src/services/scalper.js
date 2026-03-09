// src/services/scalper.js
// Scalping en TIEMPO REAL via WebSocket de Binance
// Pura matemática: detectar subidas, comprar, vender cuando baja.
// NO usa IA. Cero tokens. Cero latencia.

const WebSocket = require('ws');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { getDB } = require('../models/db');
const { getBalances, getTicker, createOrder, getOHLCV, formatAmount, getTopGainers } = require('./binance');

// ── Config ────────────────────────────────────────────────────────────────────
const SCALP_SL_PCT = 3;      // Stop-loss 3%
const SCALP_TP_PCT = 5;      // Take-profit 5%
const MIN_RISE_5MIN = 2.0;   // Mínimo +2% en 5 min para comprar
const MIN_VOLUME_USD = 2000000; // Mínimo $2M volumen 24h
const MAX_POSITIONS = 3;
const MAX_TRADES_8H = 8;
const COOLDOWN_MS = 20 * 60 * 1000; // 20 min entre trades del mismo par

// ── Estado ────────────────────────────────────────────────────────────────────
const _prices = {};       // { symbol: [{price, ts, vol},...] } — historial por coin
const _currentTick = {};  // { symbol: {price, vol, change} } — último tick
let _ws = null;
let _wsReady = false;
let _reconnectTimer = null;
let _decisionTimer = null;
let _monitorTimer = null;
let _broadcastFn = null;

// ── Helpers DB (comparte tablas con crypto-trader) ────────────────────────────

function getConfig() {
  const db = getDB();
  let cfg = db.prepare('SELECT * FROM crypto_config WHERE id = 1').get();
  if (!cfg) { db.prepare('INSERT INTO crypto_config (id) VALUES (1)').run(); cfg = db.prepare('SELECT * FROM crypto_config WHERE id = 1').get(); }
  return cfg;
}

function getOpenPositions() {
  return getDB().prepare("SELECT * FROM crypto_positions WHERE status = 'OPEN' ORDER BY created_at DESC").all();
}

function savePosition(pos) {
  return getDB().prepare(`
    INSERT INTO crypto_positions (symbol, side, quantity, entry_price, stop_loss, take_profit, status, order_id, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(pos.symbol, pos.side || 'BUY', pos.quantity, pos.entry_price,
         pos.stop_loss || 0, pos.take_profit || 0, pos.status || 'OPEN',
         pos.order_id || '', pos.reason || '');
}

function closePosition(id, pnl, reason, sellPrice, fees) {
  getDB().prepare(
    "UPDATE crypto_positions SET status = 'CLOSED', pnl = ?, sell_price = ?, fees = ?, reason = reason || ' | ' || ?, closed_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(typeof pnl === 'number' ? pnl : 0, sellPrice || 0, fees || 0, reason || 'Cerrada', id);
}

function _getApiKeyInfo() {
  const cfg = getConfig();
  const db = getDB();
  const userId = cfg.user_id || 1;
  return db.prepare("SELECT id, user_id FROM api_keys WHERE user_id = ? AND exchange = 'binance' LIMIT 1").get(userId);
}

function _getTradeCount8h() {
  const cutoff = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  const row = getDB().prepare(
    "SELECT COUNT(*) as cnt FROM crypto_positions WHERE order_id LIKE 'SCALP%' AND created_at >= ? AND side = 'BUY'"
  ).get(cutoff);
  return row?.cnt || 0;
}

// ── RSI rápido ────────────────────────────────────────────────────────────────
function calcRSI(closes) {
  if (closes.length < 15) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= 14; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / 14, avgLoss = losses / 14;
  for (let i = 15; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * 13 + (d > 0 ? d : 0)) / 14;
    avgLoss = (avgLoss * 13 + (d < 0 ? -d : 0)) / 14;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

// ── WebSocket: precios en TIEMPO REAL ─────────────────────────────────────────

function connectWebSocket() {
  if (_ws) { try { _ws.close(); } catch {} }

  const url = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
  const opts = {};

  // Usar proxy SOCKS si está configurado
  if (process.env.BINANCE_PROXY) {
    const proxyUrl = process.env.BINANCE_PROXY.replace('socks5h://', 'socks5://');
    opts.agent = new SocksProxyAgent(proxyUrl);
  }

  console.log('[Scalper] Conectando WebSocket Binance...');
  _ws = new WebSocket(url, opts);

  _ws.on('open', () => {
    _wsReady = true;
    console.log('[Scalper] ✅ WebSocket conectado — precios en TIEMPO REAL');
  });

  _ws.on('message', (data) => {
    try {
      const tickers = JSON.parse(data);
      const now = Date.now();

      for (const t of tickers) {
        // Solo pares /USDT
        if (!t.s || !t.s.endsWith('USDT')) continue;
        const symbol = t.s.replace('USDT', '/USDT');
        const price = parseFloat(t.c); // close price
        const vol = parseFloat(t.q);   // quote volume 24h

        if (price <= 0) continue;

        // Actualizar tick actual
        _currentTick[symbol] = { price, vol, ts: now };

        // Guardar en historial (1 punto cada 10 seg para no llenar memoria)
        if (!_prices[symbol]) _prices[symbol] = [];
        const hist = _prices[symbol];
        if (hist.length === 0 || (now - hist[hist.length - 1].ts) >= 10000) {
          hist.push({ price, ts: now });
          // Mantener 10 min de historia (60 puntos × 10s)
          if (hist.length > 60) hist.shift();
        }
      }
    } catch {}
  });

  _ws.on('close', () => {
    _wsReady = false;
    console.warn('[Scalper] WebSocket cerrado — reconectando en 5s...');
    _reconnectTimer = setTimeout(connectWebSocket, 5000);
  });

  _ws.on('error', (err) => {
    console.warn('[Scalper] WebSocket error:', (err.message || '').substring(0, 50));
    _wsReady = false;
  });
}

// ── Motor de decisiones (corre cada 10 seg) ──────────────────────────────────

let _lastLog = 0;

async function makeDecisions() {
  const cfg = getConfig();
  if (!cfg.enabled) return;
  const tickCount = Object.keys(_currentTick).length;
  const histCount = Object.keys(_prices).length;
  if (!_wsReady || tickCount < 50) return;

  const allPositions = getOpenPositions();
  const scalpPositions = allPositions.filter(p => p.order_id && p.order_id.startsWith('SCALP'));
  const trades8h = _getTradeCount8h();

  // Log estado cada 60 seg para que el usuario vea actividad
  const now = Date.now();
  if (now - _lastLog > 60000) {
    _lastLog = now;
    console.log(`[Scalper] RT: ${tickCount} coins, ${histCount} con historia | Posiciones: ${scalpPositions.length}/${MAX_POSITIONS} scalp, ${allPositions.length} total | Trades 8h: ${trades8h}/${MAX_TRADES_8H}`);
  }

  // Límite: max 3 posiciones SCALPER (no cuenta las de IA)
  if (scalpPositions.length >= MAX_POSITIONS) return;
  // Límite total: max 5 posiciones entre todos
  if (allPositions.length >= 5) return;
  if (trades8h >= MAX_TRADES_8H) return;

  // Buscar criptos subiendo AHORA
  const candidates = [];

  for (const [symbol, hist] of Object.entries(_prices)) {
    if (hist.length < 6) continue; // Necesita al menos 1 min de data

    // Ya tenemos posición? Skip
    if (allPositions.some(p => p.symbol === symbol)) continue;

    const current = _currentTick[symbol];
    if (!current || current.vol < MIN_VOLUME_USD) continue; // Sin volumen

    // Calcular cambio en los últimos ~5 min (30 puntos × 10s)
    const lookback = Math.min(30, hist.length - 1);
    const oldPrice = hist[hist.length - 1 - lookback].price;
    const change = ((current.price - oldPrice) / oldPrice) * 100;

    if (change < MIN_RISE_5MIN) continue; // No subió suficiente

    // Verificar tendencia: últimos 3 puntos deben ser ascendentes
    const last3 = hist.slice(-3);
    if (last3.length >= 3 && (last3[2].price <= last3[1].price || last3[1].price <= last3[0].price)) continue;

    candidates.push({ symbol, price: current.price, change, vol: current.vol });
  }

  if (!candidates.length) return;

  // Ordenar por cambio (más subida = más momentum)
  candidates.sort((a, b) => b.change - a.change);
  const top3 = candidates.slice(0, 3).map(c => `${c.symbol.replace('/USDT','')} +${c.change.toFixed(1)}%`).join(', ');
  console.log(`[Scalper] 📈 ${candidates.length} subiendo: ${top3}`);
  const best = candidates[0];

  // Cooldown check
  const recent = getDB().prepare(
    "SELECT closed_at FROM crypto_positions WHERE symbol = ? AND status = 'CLOSED' ORDER BY id DESC LIMIT 1"
  ).get(best.symbol);
  if (recent && recent.closed_at) {
    const closedAgo = now - new Date(recent.closed_at + 'Z').getTime();
    if (closedAgo < COOLDOWN_MS) return;
  }

  // RSI check rápido (velas 5 min)
  let rsi = 50;
  try {
    const candles = await getOHLCV(best.symbol, '5m', 20);
    if (candles && candles.length >= 16) rsi = calcRSI(candles.map(c => c[4]));
  } catch {}
  if (rsi > 70) {
    console.log(`[Scalper] Skip ${best.symbol}: RSI=${rsi.toFixed(0)} > 70`);
    return;
  }

  // Balance check
  const keyInfo = _getApiKeyInfo();
  if (!keyInfo) return;
  let availUSDT = 0;
  try {
    const bal = await getBalances(keyInfo.user_id, keyInfo.id);
    availUSDT = bal?.USDT?.free || 0;
  } catch {}
  if (availUSDT < 10) return;

  const tradeAmount = Math.min(Math.floor(availUSDT * 0.40), 15);
  if (tradeAmount < 6) return; // Mínimo $6 para cumplir NOTIONAL filters de Binance

  // ── COMPRAR ──
  console.log(`[Scalper] 🎯 ${best.symbol} +${best.change.toFixed(1)}% en 5min | RSI=${rsi.toFixed(0)} | $${best.price} | Vol:$${Math.round(best.vol / 1e6)}M`);

  try {
    // Obtener precio fresco para la orden
    const ticker = await getTicker(best.symbol);
    const freshPrice = ticker?.last || best.price;

    const exchange = require('./binance').getExchangeForUser(keyInfo.user_id, keyInfo.id);
    const qty = formatAmount(best.symbol, tradeAmount / freshPrice) || parseFloat((tradeAmount / freshPrice).toFixed(6));

    const order = await createOrder(keyInfo.user_id, keyInfo.id, best.symbol, 'buy', qty);
    const fillPrice = order?.average || order?.price || freshPrice;
    const fillQty = order?.filled || qty;

    const sl = Math.round(fillPrice * (1 - SCALP_SL_PCT / 100) * 100000) / 100000;
    const tp = Math.round(fillPrice * (1 + SCALP_TP_PCT / 100) * 100000) / 100000;

    savePosition({
      symbol: best.symbol, side: 'BUY', quantity: fillQty, entry_price: fillPrice,
      stop_loss: sl, take_profit: tp, status: 'OPEN',
      order_id: 'SCALP-' + (order?.id || Date.now()),
      reason: `RT Scalp: +${best.change.toFixed(1)}% en 5min, RSI=${rsi.toFixed(0)}`,
    });

    console.log(`[Scalper] ✅ BUY ${best.symbol}: ${fillQty} @ $${fillPrice} | SL:$${sl}(-${SCALP_SL_PCT}%) TP:$${tp}(+${SCALP_TP_PCT}%)`);

    if (_broadcastFn) _broadcastFn({
      type: 'scalper_buy', symbol: best.symbol, price: fillPrice, change: best.change,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`[Scalper] Error BUY ${best.symbol}: ${(e.message || '').substring(0, 60)}`);
  }
}

// ── Monitor de posiciones scalper (cada 5 seg) ───────────────────────────────

async function monitorScalpPositions() {
  const positions = getOpenPositions().filter(p => p.order_id && p.order_id.startsWith('SCALP'));
  if (!positions.length) return;

  for (const pos of positions) {
    const tick = _currentTick[pos.symbol];
    if (!tick || tick.price <= 0) continue;

    const price = tick.price;
    const pnlPct = ((price - pos.entry_price) / pos.entry_price) * 100;

    // Actualizar precio en DB
    getDB().prepare('UPDATE crypto_positions SET current_price = ? WHERE id = ?').run(price, pos.id);

    // Venta rápida: cae -2% en primeros 3 min
    const posAge = Date.now() - new Date(pos.created_at + 'Z').getTime();
    if (posAge < 3 * 60 * 1000 && pnlPct < -2) {
      console.log(`[Scalper] ⚡ SALIDA RÁPIDA ${pos.symbol}: ${pnlPct.toFixed(1)}% en ${Math.round(posAge / 60000)}min`);
      await _sellPosition(pos, `Salida rápida: ${pnlPct.toFixed(1)}%`);
      continue;
    }

    // Stop-Loss
    if (pos.stop_loss > 0 && price <= pos.stop_loss) {
      console.log(`[Scalper] 🛑 SL ${pos.symbol}: $${price.toFixed(4)} <= $${pos.stop_loss} (${pnlPct.toFixed(1)}%)`);
      await _sellPosition(pos, `SL: ${pnlPct.toFixed(1)}%`);
      continue;
    }

    // Take-Profit
    if (pos.take_profit > 0 && price >= pos.take_profit) {
      console.log(`[Scalper] 🎉 TP ${pos.symbol}: +${pnlPct.toFixed(1)}%`);
      await _sellPosition(pos, `TP: +${pnlPct.toFixed(1)}%`);
      continue;
    }

    // Trailing agresivo
    if (pnlPct > 1.5) {
      let newSL;
      if (pnlPct > 4)       newSL = pos.entry_price * 1.03;
      else if (pnlPct > 2.5) newSL = pos.entry_price * 1.015;
      else                   newSL = pos.entry_price * 1.005; // breakeven

      newSL = Math.round(newSL * 100000) / 100000;
      if (newSL > pos.stop_loss) {
        getDB().prepare('UPDATE crypto_positions SET stop_loss = ? WHERE id = ?').run(newSL, pos.id);
        console.log(`[Scalper] 📊 Trailing ${pos.symbol}: +${pnlPct.toFixed(1)}% → SL=$${newSL.toFixed(5)}`);
      }
    }
  }
}

async function _sellPosition(pos, reason) {
  try {
    const keyInfo = _getApiKeyInfo();
    if (!keyInfo) return;

    const tick = _currentTick[pos.symbol];
    let sellPrice = tick?.price || pos.current_price || pos.entry_price;
    let sold = false;

    try {
      const sellQty = formatAmount(pos.symbol, pos.quantity) || pos.quantity;
      const order = await createOrder(keyInfo.user_id, keyInfo.id, pos.symbol, 'sell', sellQty);
      sold = true;
      if (order?.average) sellPrice = order.average;
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('insufficient') || msg.includes('balance') || msg.includes('NOTIONAL')) {
        console.warn(`[Scalper] ${pos.symbol}: no se puede vender — cerrando registro`);
      } else {
        console.error(`[Scalper] Sell error: ${msg.substring(0, 60)}`);
      }
    }

    const grossPnl = (sellPrice - pos.entry_price) * pos.quantity;
    const fees = pos.entry_price * pos.quantity * 0.001 + (sold ? sellPrice * pos.quantity * 0.001 : 0);
    const netPnl = grossPnl - fees;

    getDB().prepare('UPDATE crypto_positions SET current_price = ? WHERE id = ?').run(sellPrice, pos.id);
    closePosition(pos.id, netPnl, sold ? reason : `Cerrada sin venta (${reason})`, sellPrice, fees);
    console.log(`[Scalper] ${sold ? '💰' : '📝'} SELL ${pos.symbol} @ $${sellPrice} | PnL: $${netPnl.toFixed(2)} | ${reason}`);

    if (_broadcastFn) _broadcastFn({
      type: 'scalper_sell', symbol: pos.symbol, pnl: netPnl, reason,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`[Scalper] Error vendiendo ${pos.symbol}:`, e.message);
  }
}

// ── Init / Stop ───────────────────────────────────────────────────────────────

function init(broadcastFn) {
  _broadcastFn = broadcastFn;

  // Conectar WebSocket
  connectWebSocket();

  // Motor de decisiones: cada 10 segundos analiza datos en memoria
  if (_decisionTimer) clearInterval(_decisionTimer);
  _decisionTimer = setInterval(async () => {
    try { await makeDecisions(); } catch (e) { console.error('[Scalper] Decision:', e.message); }
  }, 10 * 1000);

  // Monitor de posiciones scalp: cada 5 segundos (RÁPIDO)
  if (_monitorTimer) clearInterval(_monitorTimer);
  _monitorTimer = setInterval(async () => {
    try { await monitorScalpPositions(); } catch (e) { console.error('[Scalper] Monitor:', e.message); }
  }, 5 * 1000);

  console.log('[Scalper] Iniciado — WebSocket RT, decisiones cada 10s, monitor cada 5s');
}

function stop() {
  if (_ws) { try { _ws.close(); } catch {} _ws = null; }
  if (_reconnectTimer) clearTimeout(_reconnectTimer);
  if (_decisionTimer) clearInterval(_decisionTimer);
  if (_monitorTimer) clearInterval(_monitorTimer);
  _wsReady = false;
  console.log('[Scalper] Detenido');
}

function getStatus() {
  return {
    connected: _wsReady,
    trackedCoins: Object.keys(_currentTick).length,
    priceHistory: Object.keys(_prices).length,
  };
}

module.exports = { init, stop, getStatus };
