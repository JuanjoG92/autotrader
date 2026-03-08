// src/services/crypto-trader.js
// AI Crypto Trader — Binance 24/7, 100% separado de Cocos
// Usa: binance.js (órdenes), news-fetcher (noticias), ai-token (OpenAI), rag (contexto)

const { getDB }          = require('../models/db');
const { getOpenAIToken } = require('./ai-token');
const { getBalances, getTicker, getTopPairs, getTopGainers, createOrder, getExchangeForUser } = require('./binance');
const news               = require('./news-fetcher');
const rag                = require('./rag');

const OPENAI_MODEL = 'gpt-4o-mini';

// Base: siempre monitorear estas (referencia)
const BASE_CRYPTOS = ['BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'SOL/USDT'];
// Las demás se eligen DINÁMICAMENTE según top gainers 24h en Binance

let _timer = null;
let _monitorTimer = null;
let _broadcastFn = null;
let _lastAnalysis = null; // Last AI analysis for dashboard
let _lastMarketPrices = {}; // Cache: últimos precios para detectar cambios
let _cacheSkips = 0;        // Counter de análisis salteados por cache
let _lastNewsHash = '';     // Cache: hash de noticias para no repetir

// ── Config DB ─────────────────────────────────────────────────────────────────

function getConfig() {
  const db = getDB();
  let cfg = db.prepare('SELECT * FROM crypto_config WHERE id = 1').get();
  if (!cfg) {
    db.prepare('INSERT INTO crypto_config (id) VALUES (1)').run();
    cfg = db.prepare('SELECT * FROM crypto_config WHERE id = 1').get();
  }
  return cfg;
}

function updateConfig(changes) {
  const db = getDB();
  const fields = Object.keys(changes).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE crypto_config SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`)
    .run(...Object.values(changes));
  return getConfig();
}

// ── Posiciones DB ─────────────────────────────────────────────────────────────

function savePosition(pos) {
  return getDB().prepare(`
    INSERT INTO crypto_positions (symbol, side, quantity, entry_price, stop_loss, take_profit, status, order_id, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(pos.symbol, pos.side || 'BUY', pos.quantity, pos.entry_price,
         pos.stop_loss || 0, pos.take_profit || 0, pos.status || 'OPEN',
         pos.order_id || '', pos.reason || '');
}

function getOpenPositions() {
  return getDB().prepare("SELECT * FROM crypto_positions WHERE status = 'OPEN' ORDER BY created_at DESC").all();
}

function closePosition(id, pnl, reason) {
  getDB().prepare(
    "UPDATE crypto_positions SET status = 'CLOSED', pnl = ?, reason = reason || ' | ' || ?, closed_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(pnl || 0, reason || 'Cerrada', id);
}

function getPositionHistory(limit) {
  return getDB().prepare('SELECT * FROM crypto_positions ORDER BY created_at DESC LIMIT ?').all(limit || 30);
}

// ── Datos de mercado (dinámico: base coins + top gainers 24h) ───────────

async function getMarketData(cfg) {
  const rows = [];
  const prices = {};
  let activePairs = [...BASE_CRYPTOS];

  try {
    // 1. Top gainers dinámicos de Binance (las que más suben hoy)
    const gainers = await getTopGainers(8);
    if (gainers.length > 0) {
      // Agregar gainers que no estén en la lista base
      for (const g of gainers) {
        if (!activePairs.includes(g.symbol)) activePairs.push(g.symbol);
      }
      // Max 12 pares para no sobrecargar el prompt
      activePairs = activePairs.slice(0, 12);
    }

    // 2. Obtener datos de todos (base + gainers) en batch
    const topData = await getTopPairs();
    // Merge: topData tiene 20 pares fijos, gainers tiene las dinámicas
    const allData = [...(topData || [])];
    for (const g of gainers) {
      if (!allData.find(d => d.symbol === g.symbol)) allData.push(g);
    }

    // Separar en secciones: BASE y GAINERS
    const basePairs = [];
    const gainerPairs = [];

    for (const pair of activePairs) {
      const t = allData.find(d => d.symbol === pair);
      if (!t || t.price <= 0) continue;
      prices[pair] = t.price;
      const line = `${pair}: $${t.price.toFixed(t.price < 1 ? 4 : 2)} | 24h: ${t.change24h >= 0 ? '+' : ''}${t.change24h.toFixed(1)}% | Vol: $${Math.round(t.volume / 1e6)}M`;
      if (BASE_CRYPTOS.includes(pair)) {
        basePairs.push(line);
      } else {
        gainerPairs.push(line);
      }
    }

    if (basePairs.length) rows.push('BASE:', ...basePairs);
    if (gainerPairs.length) rows.push('\nTOP GAINERS 24H (dinámico):', ...gainerPairs);

    console.log(`[Crypto] ${activePairs.length} pares (${BASE_CRYPTOS.length} base + ${gainers.length} gainers)`);
  } catch (e) {
    console.warn('[Crypto] Error market data:', e.message?.substring(0, 60));
  }

  // Fallback: si todo falló, usar base secuencial
  if (!rows.length) {
    for (const pair of BASE_CRYPTOS) {
      try {
        const t = await getTicker(pair);
        if (t && t.last > 0) {
          prices[pair] = t.last;
          rows.push(`${pair}: $${t.last.toFixed(2)} | 24h: ${t.percentage >= 0 ? '+' : ''}${t.percentage.toFixed(1)}% | Vol: $${Math.round(t.quoteVolume / 1e6)}M`);
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return { text: rows.join('\n') || 'Sin datos de mercado.', prices, activePairs };
}

// ── Cache: detectar si el mercado cambió lo suficiente ────────────────────────

function _marketChangedEnough(currentPrices) {
  const lastKeys = Object.keys(_lastMarketPrices);
  if (!lastKeys.length) return true; // Primera vez

  for (const [symbol, price] of Object.entries(currentPrices)) {
    const prev = _lastMarketPrices[symbol];
    if (!prev) return true; // Par nuevo
    const changePct = Math.abs((price - prev) / prev) * 100;
    if (changePct >= 1.0) return true; // Algún par cambió >1%
  }
  return false; // Nada cambió significativamente
}

// ── Binance helpers ───────────────────────────────────────────────────────────

function _getApiKeyInfo(cfg) {
  const db = getDB();
  if (cfg.api_key_id > 0) {
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(cfg.api_key_id);
    if (row) return row;
  }
  // Buscar primera API key de Binance disponible
  const row = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
  return row || null;
}

async function _executeTrade(cfg, symbol, side, quantityUSD) {
  const keyInfo = _getApiKeyInfo(cfg);

  // 1. Obtener precio FRESCO justo ahora (no el del análisis de hace 5-30s)
  let price = 0;
  if (keyInfo) {
    try {
      const exchange = getExchangeForUser(keyInfo.user_id, keyInfo.id);
      const ticker = await exchange.fetchTicker(symbol);
      price = ticker?.last || ticker?.close || 0;
    } catch {}
  }
  if (price <= 0) {
    try { const t = await getTicker(symbol); price = t?.last || 0; } catch {}
  }
  if (price <= 0) throw new Error(`Sin precio para ${symbol}`);

  // 2. Calcular cantidad respetando filtros de Binance
  //    - NOTIONAL mínimo: $5-$10 según el par (usamos $8 de safety)
  //    - LOT_SIZE: ajustar decimales según precio del par
  const minNotional = 8; // $8 para superar el filtro NOTIONAL de Binance con margen
  const actualUSD = Math.max(quantityUSD, minNotional);

  // Ajustar decimales según el precio: coins baratas necesitan menos decimales en cantidad
  let decimalPlaces;
  if (price >= 10000) decimalPlaces = 5;     // BTC: 0.00014
  else if (price >= 100) decimalPlaces = 4;  // ETH/SOL: 0.0721
  else if (price >= 1) decimalPlaces = 2;    // ALCX/LINK: 0.84
  else if (price >= 0.01) decimalPlaces = 0; // DOGE/ADA: 16
  else decimalPlaces = 0;                    // SHIB: 100000

  let quantity = parseFloat((actualUSD / price).toFixed(decimalPlaces));
  // Asegurar que cantidad * precio >= minNotional
  if (quantity * price < 5) {
    quantity = parseFloat((6 / price).toFixed(decimalPlaces));
  }
  if (quantity <= 0) throw new Error(`Cantidad muy baja para ${symbol}`);

  // 3. Ejecutar en Binance (MARKET order = compra al precio actual del mercado)
  //    No importa si el precio cambió 0.1% — la orden MARKET se ejecuta al instante
  let order = null;
  let mode = 'PAPER';
  let fillPrice = price; // precio real de ejecución

  if (keyInfo) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        order = await createOrder(keyInfo.user_id, keyInfo.id, symbol, side.toLowerCase(), quantity);
        mode = 'LIVE';
        // Si Binance devuelve el precio real de ejecución, usarlo
        if (order?.average) fillPrice = order.average;
        else if (order?.price && order.price > 0) fillPrice = order.price;
        break;
      } catch (e) {
        const msg = e.message || '';
        // NOTIONAL: monto muy bajo → reintentar con más cantidad
        if (msg.includes('NOTIONAL') && attempt === 1) {
          console.warn(`[Crypto] ${symbol} NOTIONAL filter — subiendo a $${actualUSD * 1.5}`);
          quantity = parseFloat(((actualUSD * 1.5) / price).toFixed(decimalPlaces));
          continue;
        }
        // LOT_SIZE: cantidad inválida → ajustar decimales
        if (msg.includes('LOT_SIZE') && attempt === 1) {
          console.warn(`[Crypto] ${symbol} LOT_SIZE filter — ajustando decimales`);
          quantity = Math.max(1, Math.floor(actualUSD / price));
          continue;
        }
        if (attempt < 2 && (msg.includes('timed out') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET'))) {
          console.warn(`[Crypto] Orden timeout intento ${attempt}, reintentando...`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        console.warn(`[Crypto] Binance orden falló (${msg.substring(0, 80)}) — paper mode`);
        break;
      }
    }
  }

  console.log(`[Crypto] ${mode} ${side} ${symbol}: ${quantity} @ $${fillPrice} (~$${(quantity * fillPrice).toFixed(2)})`);
  return { order: order || { id: 'PAPER-' + Date.now() }, price: fillPrice, quantity, mode };
}

// ── AI Análisis ───────────────────────────────────────────────────────────────

async function runAnalysis() {
  const cfg = getConfig();
  if (!cfg.enabled) return null;

  const apiKey = await getOpenAIToken();
  if (!apiKey) { console.warn('[Crypto] Sin token OpenAI'); return null; }

  console.log('[Crypto] Iniciando análisis...');

  const t0 = Date.now();

  // ── Paso 1: Fetch paralelo (mercado + balance + RAG al mismo tiempo) ──
  const keyInfo = _getApiKeyInfo(cfg);
  const [marketResult, balanceResult, ragCtx] = await Promise.all([
    getMarketData(cfg),
    (async () => {
      try {
        if (!keyInfo) return null;
        return await getBalances(keyInfo.user_id, keyInfo.id);
      } catch { return null; }
    })(),
    // RAG con keywords (NO usa embeddings/OpenAI, es gratis)
    rag.buildRAGContext('crypto trading strategy bitcoin risk management', false).catch(() => ''),
  ]);

  const { text: marketCtx, prices: currentPrices, activePairs } = marketResult;
  console.log(`[Crypto] Datos obtenidos en ${Date.now() - t0}ms (paralelo)`);

  // ── Paso 2: Cache — si nada cambió >1%, saltar OpenAI ──
  const hasOpenPositions = getOpenPositions().length > 0;
  if (!_marketChangedEnough(currentPrices) && !hasOpenPositions) {
    _cacheSkips++;
    console.log(`[Crypto] ⏭️ Mercado sin cambios — skip OpenAI (${_cacheSkips} skips)`);
    return _lastAnalysis;
  }
  _lastMarketPrices = { ...currentPrices };

  // ── Paso 3: Armar contexto (ya tenemos todo, sin esperar) ──
  // Noticias: usar los tickers activos (dinámicos)
  const newsTickers = (activePairs || BASE_CRYPTOS).map(p => p.split('/')[0]).concat(['CRYPTO']);
  const newsItems = news.getNewsForTickers(newsTickers, 6);
  const newsHash = newsItems.map(n => n.title).join('|').substring(0, 200);
  let newsCtx;
  if (newsHash === _lastNewsHash && _lastAnalysis) {
    newsCtx = 'Sin cambios en noticias desde último análisis.';
  } else {
    newsCtx = newsItems.length
      ? newsItems.map(n => `- ${n.title.substring(0, 80)}`).join('\n')
      : 'Sin noticias crypto recientes.';
    _lastNewsHash = newsHash;
  }

  const positions = getOpenPositions();
  const posCtx = positions.length
    ? positions.map(p => `${p.symbol}: ${p.quantity} @ $${p.entry_price} (SL:$${p.stop_loss} TP:$${p.take_profit})`).join('\n')
    : 'Sin posiciones abiertas.';

  let balanceCtx = 'USDT libre: $0 (sin conexión)';
  let availableUSDT = 0;
  if (balanceResult) {
    availableUSDT = balanceResult.USDT?.free || 0;
    const entries = Object.entries(balanceResult).filter(([k, v]) => v.total > 0 && k !== 'USDT').slice(0, 5);
    balanceCtx = `USDT libre: $${availableUSDT.toFixed(2)}`;
    if (entries.length) balanceCtx += ' | ' + entries.map(([k, v]) => `${k}: ${v.total}`).join(', ');
  }

  const positionSize = Math.max(5, Math.min(availableUSDT * 0.20, availableUSDT - 2));

  // Prompt compacto con top gainers dinámicos
  const prompt = `CRYPTO TRADING — Binance Spot — FOCO EN TOP GAINERS

MERCADO (incluye top gainers 24h dinámicos de Binance):
${marketCtx}

BALANCE: ${balanceCtx} | Operación: ~$${positionSize.toFixed(0)} | Riesgo: ${cfg.risk_level} | SL:${cfg.stop_loss_pct}% TP:${cfg.take_profit_pct}%

POSICIONES: ${posCtx}

NOTICIAS: ${newsCtx}
${ragCtx ? `\nESTRATEGIA (RAG): ${ragCtx.substring(0, 500)}` : ''}
REGLAS: Comisión 0.2% round-trip (operar si >0.5%). PRIORIZAR top gainers con momentum fuerte y volumen alto. No overtrading. HOLD si no hay oportunidad clara. Max 25% capital/operación. Cualquier par /USDT listado arriba es válido. No comprar duplicados. SELL si debilidad. Confidence 0.60-0.95 (ejecutar >0.75). Incluir amount_usd.

JSON:
{"signals":[{"symbol":"XXX/USDT","action":"BUY|SELL|HOLD","confidence":0.82,"amount_usd":10,"reason":"..."}],"analysis":"resumen breve","market_sentiment":"BULLISH|BEARISH|NEUTRAL","watchlist":["ETH/USDT"]}`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: OPENAI_MODEL, temperature: 0.2, max_tokens: 800,
        messages: [
          { role: 'system', content: 'Eres un trader de criptomonedas experto. Analizas mercado + noticias para generar señales de trading. Conservador. JSON válido siempre.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) { console.error('[Crypto] OpenAI error:', res.status); return null; }
    const result = JSON.parse((await res.json()).choices[0].message.content);

    console.log(`[Crypto] ${(result.signals||[]).length} señales | ${result.market_sentiment} | ${result.analysis?.substring(0, 80)}`);

    // Save analysis for dashboard
    _lastAnalysis = { ...result, timestamp: new Date().toISOString() };

    // Ejecutar señales
    for (const sig of (result.signals || [])) {
      if (!sig.symbol || (sig.confidence || 0) < cfg.min_confidence) continue;
      if (sig.action === 'HOLD') continue;

      // Re-read positions fresh (may have changed during loop)
      const currentPositions = getOpenPositions();

      // No comprar si ya tenemos posición abierta
      if (sig.action === 'BUY' && currentPositions.some(p => p.symbol === sig.symbol)) {
        console.log(`[Crypto] Skip ${sig.symbol} — ya tenemos posición abierta`);
        continue;
      }

      // Cooldown: no comprar si vendimos/cerramos este par hace menos de 30 min
      if (sig.action === 'BUY') {
        const recent = getDB().prepare(
          "SELECT created_at FROM crypto_positions WHERE symbol = ? AND status = 'CLOSED' ORDER BY id DESC LIMIT 1"
        ).get(sig.symbol);
        if (recent) {
          const closedAgo = Date.now() - new Date(recent.created_at + 'Z').getTime();
          if (closedAgo < 30 * 60 * 1000) {
            console.log(`[Crypto] Skip ${sig.symbol} — operado hace ${Math.round(closedAgo / 60000)} min (cooldown 30min)`);
            continue;
          }
        }
      }

      // Smart amount: use AI suggested amount or 20% of available capital
      const tradeAmount = Math.min(sig.amount_usd || positionSize, availableUSDT - 2);
      if (sig.action === 'BUY' && tradeAmount < 5) {
        console.log(`[Crypto] Skip ${sig.symbol} — saldo insuficiente ($${availableUSDT.toFixed(2)})`);
        continue;
      }

      try {
        if (sig.action === 'BUY') {
          const { order, price, quantity } = await _executeTrade(cfg, sig.symbol, 'buy', tradeAmount);
          const sl = Math.round(price * (1 - cfg.stop_loss_pct / 100) * 100) / 100;
          const tp = Math.round(price * (1 + cfg.take_profit_pct / 100) * 100) / 100;
          savePosition({
            symbol: sig.symbol, side: 'BUY', quantity, entry_price: price,
            stop_loss: sl, take_profit: tp, status: 'OPEN',
            order_id: order?.id || '', reason: sig.reason,
          });
          console.log(`[Crypto] ✅ BUY ${sig.symbol}: ${quantity} @ $${price} | SL:$${sl} TP:$${tp}`);
        }

        if (sig.action === 'SELL') {
          const pos = positions.find(p => p.symbol === sig.symbol);
          if (pos) {
            await _executeSellPosition(cfg, pos, sig.reason);
          }
        }
      } catch (e) {
        console.error(`[Crypto] Error ${sig.action} ${sig.symbol}:`, e.message);
      }
    }

    if (_broadcastFn) _broadcastFn({ type: 'crypto_analysis', data: result, timestamp: new Date().toISOString() });
    return result;
  } catch (e) {
    console.error('[Crypto] Error análisis:', e.message);
    return null;
  }
}

// ── Monitor de posiciones ─────────────────────────────────────────────────────

async function monitorPositions() {
  const cfg = getConfig();
  if (!cfg.enabled) return;

  const positions = getOpenPositions();
  if (!positions.length) return;

  for (const pos of positions) {
    try {
      // Skip positions younger than 2 minutes (dejar que se procese la orden)
      const posAge = Date.now() - new Date(pos.created_at + 'Z').getTime();
      if (posAge < 2 * 60 * 1000) continue;

      const ticker = await getTicker(pos.symbol);
      const price = ticker?.last || 0;
      if (price <= 0) continue;

      // Actualizar precio actual
      getDB().prepare('UPDATE crypto_positions SET current_price = ? WHERE id = ?').run(price, pos.id);

      const pnlPct = ((price - pos.entry_price) / pos.entry_price) * 100;

      // Stop-Loss
      if (pos.stop_loss > 0 && price <= pos.stop_loss) {
        console.log(`[Crypto] 🛑 STOP-LOSS ${pos.symbol}: $${price} <= $${pos.stop_loss} (${pnlPct.toFixed(1)}%)`);
        await _executeSellPosition(cfg, pos, `Stop-loss: ${pnlPct.toFixed(1)}%`);
        continue;
      }

      // Take-Profit
      if (pos.take_profit > 0 && price >= pos.take_profit) {
        console.log(`[Crypto] 🎉 TAKE-PROFIT ${pos.symbol}: $${price} >= $${pos.take_profit} (+${pnlPct.toFixed(1)}%)`);
        await _executeSellPosition(cfg, pos, `Take-profit: +${pnlPct.toFixed(1)}%`);
        continue;
      }

      // Trailing stop: si ganó > 4%, subir SL a entry +1%
      if (pnlPct > 4 && pos.stop_loss < pos.entry_price) {
        const newSL = Math.round(pos.entry_price * 1.01 * 100) / 100;
        getDB().prepare('UPDATE crypto_positions SET stop_loss = ? WHERE id = ?').run(newSL, pos.id);
        console.log(`[Crypto] 📊 Trailing ${pos.symbol}: SL → $${newSL}`);
      }

      await new Promise(r => setTimeout(r, 300));
    } catch {}
  }
}

async function _executeSellPosition(cfg, pos, reason) {
  try {
    const ticker = await getTicker(pos.symbol);
    const price = ticker?.last || pos.current_price || pos.entry_price;
    const pnl = (price - pos.entry_price) * pos.quantity;

    const keyInfo = _getApiKeyInfo(cfg);
    let sold = false;

    if (keyInfo) {
      // Try selling with retry
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await createOrder(keyInfo.user_id, keyInfo.id, pos.symbol, 'sell', pos.quantity);
          sold = true;
          break;
        } catch (e) {
          const msg = e.message || '';

          // NOTIONAL: amount too small for Binance ($5 min) — close position, nothing to sell
          if (msg.includes('NOTIONAL')) {
            console.warn(`[Crypto] ${pos.symbol} monto muy bajo para vender ($${(pos.quantity * price).toFixed(2)}) — cerrando posición`);
            break;
          }

          // Insufficient balance: position qty doesn't match Binance — try selling actual balance
          if (msg.includes('insufficient') || msg.includes('balance')) {
            try {
              const bal = await getBalances(keyInfo.user_id, keyInfo.id);
              const coin = pos.symbol.split('/')[0];
              const realQty = bal[coin]?.free || 0;
              if (realQty > 0 && (realQty * price) >= 5) {
                console.log(`[Crypto] Vendiendo balance real: ${realQty} ${coin} (posición decía ${pos.quantity})`);
                await createOrder(keyInfo.user_id, keyInfo.id, pos.symbol, 'sell', parseFloat(realQty.toFixed(6)));
                sold = true;
              } else {
                console.warn(`[Crypto] ${coin} real: ${realQty} (muy poco) — cerrando posición`);
              }
            } catch {}
            break;
          }

          // Timeout: retry
          if (attempt < 2 && (msg.includes('timed out') || msg.includes('ETIMEDOUT'))) {
            console.warn(`[Crypto] Sell timeout intento ${attempt}, reintentando...`);
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }

          console.error(`[Crypto] Sell error: ${msg.substring(0, 80)}`);
          break;
        }
      }
    }

    closePosition(pos.id, sold ? pnl : 0, sold ? reason : `Cerrada (${reason})`);
    console.log(`[Crypto] ${sold ? '💰' : '📝'} SELL ${pos.symbol} x${pos.quantity} @ $${price} | PnL: $${(sold ? pnl : 0).toFixed(2)} | ${reason}`);

    if (_broadcastFn) _broadcastFn({
      type: 'crypto_sell', symbol: pos.symbol, quantity: pos.quantity,
      entry: pos.entry_price, exit: price, pnl: sold ? pnl : 0, reason,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`[Crypto] Error vendiendo ${pos.symbol}:`, e.message);
  }
}

// ── Init / Control ────────────────────────────────────────────────────────────

function init(broadcastFn) {
  _broadcastFn = broadcastFn;
  const cfg = getConfig();
  const intervalMs = (cfg.analysis_interval_min || 15) * 60 * 1000;

  if (_timer) clearInterval(_timer);
  if (_monitorTimer) clearInterval(_monitorTimer);

  _timer = setInterval(async () => {
    try { await runAnalysis(); } catch (e) { console.error('[Crypto]', e.message); }
  }, intervalMs);

  _monitorTimer = setInterval(async () => {
    try { await monitorPositions(); } catch (e) { console.error('[Crypto] Monitor:', e.message); }
  }, 30 * 1000);

  console.log(`[Crypto] AI Trader iniciado — análisis cada ${cfg.analysis_interval_min || 15} min, monitor cada 30s`);

  // Primer análisis tras 20s
  setTimeout(async () => {
    try { await runAnalysis(); } catch (e) { console.error('[Crypto] Inicial:', e.message); }
  }, 20000);
}

function getStatus() {
  const cfg = getConfig();
  const positions = getOpenPositions();
  return {
    enabled: !!cfg.enabled,
    openPositions: positions.length,
    positions: positions.map(p => {
      // Si no tiene precio actual, usar el de entrada como fallback
      const current = p.current_price || p.entry_price;
      const pnlPct = current > 0 && p.entry_price > 0
        ? (((current - p.entry_price) / p.entry_price) * 100).toFixed(1) + '%'
        : 'N/A';
      return {
        symbol: p.symbol, qty: p.quantity, entry: p.entry_price,
        current, sl: p.stop_loss, tp: p.take_profit, side: p.side, pnlPct,
        mode: (p.order_id && p.order_id.startsWith('PAPER')) ? 'PAPER' : 'LIVE',
      };
    }),
    config: { max_usd: cfg.max_per_trade_usd, risk: cfg.risk_level, sl: cfg.stop_loss_pct, tp: cfg.take_profit_pct },
    lastAnalysis: _lastAnalysis,
  };
}

function getLastAnalysis() {
  return _lastAnalysis;
}

module.exports = {
  init, getConfig, updateConfig, runAnalysis, monitorPositions,
  getStatus, getOpenPositions, getPositionHistory, getLastAnalysis,
};
