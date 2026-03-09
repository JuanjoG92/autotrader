// src/services/crypto-trader.js
// AI Crypto Trader — Binance 24/7, 100% separado de Cocos
// Usa: binance.js (órdenes), news-fetcher (noticias), ai-token (OpenAI), rag (contexto)

const { getDB }          = require('../models/db');
const { getOpenAIToken } = require('./ai-token');
const { getBalances, getTicker, getTopPairs, getTopGainers, checkNewListings, createOrder, getExchangeForUser, getMarketInfo, formatAmount, getOHLCV } = require('./binance');
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

function closePosition(id, pnl, reason, sellPrice, fees) {
  getDB().prepare(
    "UPDATE crypto_positions SET status = 'CLOSED', pnl = ?, sell_price = ?, fees = ?, reason = reason || ' | ' || ?, closed_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(typeof pnl === 'number' ? pnl : 0, sellPrice || 0, fees || 0, reason || 'Cerrada', id);
}

function getPositionHistory(limit) {
  return getDB().prepare("SELECT * FROM crypto_positions WHERE order_id NOT LIKE 'PAPER%' ORDER BY created_at DESC LIMIT ?").all(limit || 30);
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
      const momentum = t.momentumScore ? ` | Momentum: ${t.momentumScore}` : '';
      const drop = t.dropFromHigh !== undefined ? ` | Drop: -${t.dropFromHigh}%` : '';
      const line = `${pair}: $${t.price.toFixed(t.price < 1 ? 4 : 2)} | 24h: ${t.change24h >= 0 ? '+' : ''}${t.change24h.toFixed(1)}% | Vol: $${Math.round(t.volume / 1e6)}M${momentum}${drop}`;
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
    if (changePct >= 0.3) return true; // Algún par cambió >0.3%
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
  const row = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
  return row || null;
}

// ── RSI (Relative Strength Index) ─────────────────────────────────────────────

function _calculateRSI(closes, period) {
  period = period || 14;
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - diff) / period;
    }
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

// ── Validación pre-compra: 2 reglas simples y profesionales ────────────────
// 1. RSI < 70 → no está sobrecomprada
// 2. Precio cerca del máximo reciente → sigue subiendo, no cayendo

async function _checkBuyConditions(symbol, change24h) {
  try {
    const candles = await getOHLCV(symbol, '15m', 30);
    if (candles && candles.length >= 16) {
      const closes = candles.map(c => c[4]);
      const rsi = _calculateRSI(closes);

      // Regla 1: RSI < 70 (no sobrecomprada)
      if (rsi > 70) {
        console.log(`[Crypto] ⚠️ Skip ${symbol}: RSI=${rsi.toFixed(0)} > 70 — sobrecomprada`);
        return { ok: false, reason: `RSI ${rsi.toFixed(0)} sobrecomprada` };
      }

      // Regla 2: precio no cayó >3% del máximo reciente (sigue subiendo)
      const recentHighs = candles.slice(-6).map(c => c[2]);
      const recentHigh = Math.max(...recentHighs);
      const currentPrice = closes[closes.length - 1];
      const dropFromHigh = ((recentHigh - currentPrice) / recentHigh) * 100;
      if (dropFromHigh > 3) {
        console.log(`[Crypto] ⚠️ Skip ${symbol}: cayó ${dropFromHigh.toFixed(1)}% del máximo — está bajando`);
        return { ok: false, reason: `cayendo ${dropFromHigh.toFixed(1)}%` };
      }

      console.log(`[Crypto] ✓ ${symbol}: RSI=${rsi.toFixed(0)}, +${change24h.toFixed(0)}%, drop=${dropFromHigh.toFixed(1)}% — OK`);
      return { ok: true, rsi };
    }
  } catch (e) {
    console.warn(`[Crypto] RSI check failed for ${symbol}: ${(e.message || '').substring(0, 40)}`);
  }
  console.log(`[Crypto] ⚠️ Skip ${symbol}: sin datos técnicos`);
  return { ok: false, reason: 'Sin datos RSI' };
}

// ── Control de trades recientes ───────────────────────────────────────────────

function _getTodayTradeCount() {
  // Contar trades de las últimas 8 horas (no desde medianoche UTC)
  const cutoff = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  const row = getDB().prepare(
    "SELECT COUNT(*) as cnt FROM crypto_positions WHERE order_id NOT LIKE 'PAPER%' AND created_at >= ? AND side = 'BUY'"
  ).get(cutoff);
  return row?.cnt || 0;
}

async function _executeTrade(cfg, symbol, side, quantityUSD) {
  const keyInfo = _getApiKeyInfo(cfg);
  if (!keyInfo) throw new Error('Sin API key de Binance configurada — no se opera en PAPER');

  // 1. Cargar filtros REALES de Binance (LOT_SIZE, MIN_NOTIONAL)
  let market = null;
  try { market = await getMarketInfo(symbol); } catch {}

  // 2. Obtener precio FRESCO justo ahora
  let price = 0;
  try {
    const exchange = getExchangeForUser(keyInfo.user_id, keyInfo.id);
    const ticker = await exchange.fetchTicker(symbol);
    price = ticker?.last || ticker?.close || 0;
  } catch {}
  if (price <= 0) {
    try { const t = await getTicker(symbol); price = t?.last || 0; } catch {}
  }
  if (price <= 0) throw new Error(`Sin precio para ${symbol}`);

  // 3. Calcular cantidad respetando filtros REALES de Binance
  const minNotional = market?.limits?.cost?.min || 5;
  const minAmount = market?.limits?.amount?.min || 0;
  const actualUSD = Math.max(quantityUSD, minNotional * 1.5);

  let quantity;
  if (market) {
    quantity = formatAmount(symbol, actualUSD / price);
    if (quantity * price < minNotional) {
      quantity = formatAmount(symbol, (minNotional * 1.5) / price);
    }
    if (quantity < minAmount) quantity = minAmount;
  } else {
    let decimalPlaces;
    if (price >= 10000) decimalPlaces = 5;
    else if (price >= 100) decimalPlaces = 4;
    else if (price >= 1) decimalPlaces = 2;
    else if (price >= 0.01) decimalPlaces = 0;
    else decimalPlaces = 0;
    quantity = parseFloat((actualUSD / price).toFixed(decimalPlaces));
    if (quantity * price < 5) {
      quantity = parseFloat((6 / price).toFixed(decimalPlaces));
    }
  }
  if (quantity <= 0) throw new Error(`Cantidad muy baja para ${symbol}`);

  // 4. Ejecutar en Binance (MARKET order) — SOLO LIVE, nunca PAPER
  let order = null;
  let fillPrice = price;
  let fillQuantity = quantity;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      order = await createOrder(keyInfo.user_id, keyInfo.id, symbol, side.toLowerCase(), quantity);
      // Usar datos REALES de Binance: precio y cantidad ejecutada
      if (order?.average) fillPrice = order.average;
      else if (order?.price && order.price > 0) fillPrice = order.price;
      if (order?.filled && order.filled > 0) fillQuantity = order.filled;
      else if (order?.amount && order.amount > 0) fillQuantity = order.amount;
      break;
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('NOTIONAL') && attempt === 1) {
        console.warn(`[Crypto] ${symbol} NOTIONAL — subiendo cantidad`);
        quantity = market
          ? formatAmount(symbol, (actualUSD * 2) / price)
          : parseFloat(((actualUSD * 2) / price).toFixed(2));
        continue;
      }
      if (msg.includes('LOT_SIZE') && attempt === 1) {
        console.warn(`[Crypto] ${symbol} LOT_SIZE — ajustando con floor`);
        quantity = market
          ? formatAmount(symbol, Math.floor(actualUSD / price))
          : Math.max(1, Math.floor(actualUSD / price));
        continue;
      }
      if (attempt < 2 && (msg.includes('timed out') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET'))) {
        console.warn(`[Crypto] Orden timeout intento ${attempt}, reintentando...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      console.warn(`[Crypto] Binance orden falló (${msg.substring(0, 80)})`);
      throw new Error(`Orden rechazada: ${msg.substring(0, 60)}`);
    }
  }

  if (!order) throw new Error(`Orden no ejecutada para ${symbol}`);

  console.log(`[Crypto] LIVE ${side} ${symbol}: ${fillQuantity} @ $${fillPrice} (~$${(fillQuantity * fillPrice).toFixed(2)})`);
  return { order, price: fillPrice, quantity: fillQuantity };
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
    ? positions.map(p => {
        const curPrice = currentPrices[p.symbol] || p.current_price || p.entry_price;
        const pnl = ((curPrice - p.entry_price) / p.entry_price * 100).toFixed(1);
        return `${p.symbol}: ${p.quantity} @ $${p.entry_price} → $${curPrice} (${pnl}%) SL:$${p.stop_loss} TP:$${p.take_profit}`;
      }).join('\n')
    : 'Sin posiciones abiertas.';

  let balanceCtx = 'USDT libre: $0 (sin conexión)';
  let availableUSDT = 0;
  let totalPortfolio = 0;
  if (balanceResult) {
    availableUSDT = balanceResult.USDT?.free || 0;
    totalPortfolio = availableUSDT;
    const holdings = [];
    for (const [coin, info] of Object.entries(balanceResult)) {
      if (coin === 'USDT' || coin === 'ARS' || !info.total || info.total <= 0) continue;
      let pairPrice = currentPrices[coin + '/USDT'] || 0;
      // Si no está en los pares activos, buscar precio individual
      if (pairPrice === 0) {
        try { const t = await getTicker(coin + '/USDT'); pairPrice = t?.last || 0; } catch {}
      }
      const val = info.total * pairPrice;
      if (val > 0.5) {
        totalPortfolio += val;
        holdings.push(`${coin}:$${val.toFixed(1)}`);
      }
    }
    balanceCtx = `USDT libre: $${availableUSDT.toFixed(2)} | Portfolio total: ~$${totalPortfolio.toFixed(2)}`;
    if (holdings.length) balanceCtx += ' | ' + holdings.join(', ');
    console.log(`[Crypto] 💰 USDT=$${availableUSDT.toFixed(2)} | Total=$${totalPortfolio.toFixed(2)} | ${holdings.join(', ') || 'solo USDT'}`);
  } else {
    console.warn('[Crypto] ⚠️ No se pudo leer balance de Binance');
  }

  // Invertir 40% del USDT disponible por operación
  const positionSize = Math.max(10, Math.floor(availableUSDT * 0.40));

  // ── PRE-ANÁLISIS TÉCNICO: calcular RSI real de los top coins ──
  const topCoins = (activePairs || BASE_CRYPTOS).filter(p => !BASE_CRYPTOS.includes(p)).slice(0, 6);
  const allGainers = await getTopGainers(20);
  const technicalData = [];
  for (const symbol of topCoins) {
    try {
      const candles = await getOHLCV(symbol, '15m', 20);
      if (candles && candles.length >= 16) {
        const closes = candles.map(c => c[4]);
        const rsi = _calculateRSI(closes);
        const recentHigh = Math.max(...candles.slice(-6).map(c => c[2]));
        const currentPrice = closes[closes.length - 1];
        const dropFromHigh = ((recentHigh - currentPrice) / recentHigh) * 100;
        const gainer = allGainers.find(g => g.symbol === symbol);
        const change = gainer?.change24h || 0;
        technicalData.push({ symbol, rsi: Math.round(rsi), change: Math.round(change), dropFromHigh: Math.round(dropFromHigh * 10) / 10 });
      }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  // También analizar las base coins
  for (const symbol of BASE_CRYPTOS) {
    try {
      const candles = await getOHLCV(symbol, '15m', 20);
      if (candles && candles.length >= 16) {
        const closes = candles.map(c => c[4]);
        const rsi = _calculateRSI(closes);
        technicalData.push({ symbol, rsi: Math.round(rsi), change: 0, dropFromHigh: 0 });
      }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  const techCtx = technicalData.length
    ? technicalData.map(t => `${t.symbol}: RSI=${t.rsi} | 24h=${t.change >= 0 ? '+' : ''}${t.change}% | Drop=-${t.dropFromHigh}%`).join('\n')
    : 'Sin datos técnicos.';

  const prompt = `CRYPTO TRADER — Binance Spot — DATOS TÉCNICOS REALES

MERCADO:
${marketCtx}

INDICADORES TÉCNICOS REALES (RSI 14 en velas 15min):
${techCtx}

BALANCE: ${balanceCtx} | USDT libre: $${availableUSDT.toFixed(0)} | Invertir ~$${positionSize} por operación

POSICIONES ABIERTAS: ${posCtx}

NOTICIAS: ${newsCtx}

REGLAS DE TRADING:
1. COMPRAR si RSI < 70 (no sobrecomprada) Y precio cerca del máximo reciente (drop < 3%).
2. Preferir RSI 30-55 (mejor zona de entrada) y volumen >$3M.
3. Cualquier cripto puede ser buena si RSI es favorable — no importa si subió 5% o 50%.
4. SELL solo si posición bajó más de -${cfg.stop_loss_pct || 5}% desde entrada.
5. Sin USDT libre → HOLD. Posiciones en ganancia → HOLD.
6. amount_usd = $${positionSize}. Confidence > 0.80 solo con RSI favorable.
7. Si NINGUNA cripto tiene RSI favorable → NO dar BUY. Esperar es válido.

JSON:
{"signals":[{"symbol":"XXX/USDT","action":"BUY|SELL|HOLD","confidence":0.85,"amount_usd":${positionSize},"reason":"RSI=XX, ..."}],"analysis":"breve","market_sentiment":"BULLISH|BEARISH|NEUTRAL","watchlist":[]}`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: OPENAI_MODEL, temperature: 0.2, max_tokens: 800,
        messages: [
          { role: 'system', content: 'Eres un trader técnico. Decides basándote en RSI y precio vs máximo reciente. RSI < 70 y precio cerca del high = comprar. RSI > 70 o precio cayendo = esperar. Si nada cumple, no dar BUY. JSON válido siempre.' },
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

    // ── Ejecutar señales: SELLS PRIMERO, luego re-leer balance, luego BUYS ──
    const sells = (result.signals || []).filter(s => s.action === 'SELL' && s.symbol && (s.confidence || 0) >= cfg.min_confidence);
    const buys  = (result.signals || []).filter(s => s.action === 'BUY'  && s.symbol && (s.confidence || 0) >= cfg.min_confidence);

    // Paso A: Ejecutar SELLS — SOLO si posición realmente tocó stop-loss
    for (const sig of sells) {
      const pos = positions.find(p => p.symbol === sig.symbol);
      if (!pos) continue;
      const curPrice = currentPrices[pos.symbol] || pos.current_price || pos.entry_price;
      const pnlPct = ((curPrice - pos.entry_price) / pos.entry_price) * 100;
      const slThreshold = -(cfg.stop_loss_pct || 3);
      if (pnlPct > slThreshold) {
        console.log(`[Crypto] ❌ BLOQUEADO SELL AI ${sig.symbol}: PnL ${pnlPct.toFixed(1)}% > SL ${slThreshold}% — ventas solo por SL/TP/trailing`);
        continue;
      }
      try {
        await _executeSellPosition(cfg, pos, sig.reason);
      } catch (e) { console.error(`[Crypto] Error SELL ${sig.symbol}:`, e.message); }
    }

    // Paso B: Si vendimos algo, re-leer balance FRESCO
    if (sells.length > 0 && keyInfo) {
      try {
        const freshBal = await getBalances(keyInfo.user_id, keyInfo.id);
        if (freshBal?.USDT) {
          availableUSDT = freshBal.USDT.free || 0;
          console.log(`[Crypto] Balance actualizado post-venta: $${availableUSDT.toFixed(2)} USDT libre`);
        }
      } catch {}
    }

    // Paso C: Ejecutar BUYS con el balance actualizado
    const todayTrades = _getTodayTradeCount();
    const MAX_DAILY_TRADES = 6;

    for (const sig of buys) {
      // Límite diario de trades
      if (todayTrades + buys.indexOf(sig) >= MAX_DAILY_TRADES) {
        console.log(`[Crypto] Skip ${sig.symbol} — límite diario alcanzado (${MAX_DAILY_TRADES} trades/día)`);
        continue;
      }

      const currentPositions = getOpenPositions();

      if (currentPositions.some(p => p.symbol === sig.symbol)) {
        console.log(`[Crypto] Skip ${sig.symbol} — ya tenemos posición abierta`);
        continue;
      }

      // Máximo 3 posiciones abiertas simultáneas
      if (currentPositions.length >= 3) {
        console.log(`[Crypto] Skip ${sig.symbol} — ya hay ${currentPositions.length} posiciones abiertas (max 3)`);
        continue;
      }

      // Cooldown: no recomprar inmediatamente tras vender (evita loop de pérdidas)
      const recent = getDB().prepare(
        "SELECT closed_at FROM crypto_positions WHERE symbol = ? AND status = 'CLOSED' ORDER BY id DESC LIMIT 1"
      ).get(sig.symbol);
      if (recent && recent.closed_at) {
        const closedAgo = Date.now() - new Date(recent.closed_at + 'Z').getTime();
        if (closedAgo < 30 * 60 * 1000) {
          console.log(`[Crypto] Skip ${sig.symbol} — vendido hace ${Math.round(closedAgo / 60000)} min (cooldown 30min)`);
          continue;
        }
      }

      const tradeAmount = Math.max(10, Math.min(sig.amount_usd || positionSize, availableUSDT - 2));
      if (availableUSDT < 10) {
        console.log(`[Crypto] Skip ${sig.symbol} — USDT libre: $${availableUSDT.toFixed(2)} (necesita >$10)`);
        continue;
      }

      // ── VALIDACIÓN PRE-COMPRA: usar datos técnicos ya calculados ──
      const techData = technicalData.find(t => t.symbol === sig.symbol);
      const gainerData = (await getTopGainers(20)).find(g => g.symbol === sig.symbol);
      const change24h = gainerData?.change24h || techData?.change || 0;

      // Validar con datos técnicos pre-calculados o en tiempo real
      if (techData && techData.rsi > 0) {
        if (techData.rsi > 70) {
          console.log(`[Crypto] ❌ BLOQUEADO ${sig.symbol}: RSI=${techData.rsi} > 70`);
          continue;
        }
        if (techData.dropFromHigh > 3) {
          console.log(`[Crypto] ❌ BLOQUEADO ${sig.symbol}: cayendo ${techData.dropFromHigh}% del máximo`);
          continue;
        }
        console.log(`[Crypto] ✓ ${sig.symbol}: RSI=${techData.rsi}, +${change24h.toFixed(0)}%, drop=${techData.dropFromHigh}% — OK`);
      } else {
        const buyCheck = await _checkBuyConditions(sig.symbol, change24h);
        if (!buyCheck.ok) {
          console.log(`[Crypto] ❌ BLOQUEADO ${sig.symbol}: ${buyCheck.reason}`);
          continue;
        }
      }

      try {
        const { order, price, quantity } = await _executeTrade(cfg, sig.symbol, 'buy', tradeAmount);
        const sl = Math.round(price * (1 - cfg.stop_loss_pct / 100) * 10000) / 10000;
        const tp = Math.round(price * (1 + cfg.take_profit_pct / 100) * 10000) / 10000;
        savePosition({
          symbol: sig.symbol, side: 'BUY', quantity, entry_price: price,
          stop_loss: sl, take_profit: tp, status: 'OPEN',
          order_id: order?.id || '', reason: sig.reason,
        });
        console.log(`[Crypto] ✅ BUY ${sig.symbol}: ${quantity} @ $${price} | SL:$${sl} TP:$${tp} | RSI:${buyCheck.rsi?.toFixed(0) || '?'}`);
        availableUSDT -= (quantity * price);
      } catch (e) {
        console.error(`[Crypto] Error BUY ${sig.symbol}:`, e.message);
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
// SIEMPRE corre aunque el bot esté desactivado — protege posiciones abiertas

async function monitorPositions() {
  const cfg = getConfig();
  // NO verificar cfg.enabled — el monitor SIEMPRE debe proteger posiciones abiertas

  const positions = getOpenPositions();
  if (!positions.length) return;

  for (const pos of positions) {
    try {
      // Skip positions younger than 30 seconds (dejar que se procese la orden)
      const posAge = Date.now() - new Date(pos.created_at + 'Z').getTime();
      if (posAge < 30 * 1000) continue;

      const ticker = await getTicker(pos.symbol);
      const price = ticker?.last || 0;
      if (price <= 0) continue;

      // Actualizar precio actual
      getDB().prepare('UPDATE crypto_positions SET current_price = ? WHERE id = ?').run(price, pos.id);

      const pnlPct = ((price - pos.entry_price) / pos.entry_price) * 100;
      const posAgeMin = posAge / 60000;

      // VENTA RÁPIDA: si cae >3% en los primeros 5 min, la entrada fue mala → salir YA
      if (posAgeMin < 5 && pnlPct < -3) {
        console.log(`[Crypto] ⚡ VENTA RÁPIDA ${pos.symbol}: ${pnlPct.toFixed(1)}% en ${posAgeMin.toFixed(0)}min — mala entrada`);
        await _executeSellPosition(cfg, pos, `Venta rápida: ${pnlPct.toFixed(1)}% en ${posAgeMin.toFixed(0)}min`);
        continue;
      }

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

      // ── Trailing Stop dinámico ──
      if (pnlPct > 3) {
        let newSL;
        if (pnlPct > 25)      newSL = pos.entry_price * 1.20;
        else if (pnlPct > 15)  newSL = pos.entry_price * 1.10;
        else if (pnlPct > 10)  newSL = pos.entry_price * 1.06;
        else if (pnlPct > 6)   newSL = pos.entry_price * 1.03;
        else if (pnlPct > 3)   newSL = pos.entry_price * 1.01;

        newSL = Math.round(newSL * 10000) / 10000;
        if (newSL > pos.stop_loss) {
          getDB().prepare('UPDATE crypto_positions SET stop_loss = ? WHERE id = ?').run(newSL, pos.id);
          console.log(`[Crypto] 📊 Trailing ${pos.symbol}: +${pnlPct.toFixed(1)}% → SL a $${newSL}`);
        }
      }

      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.warn(`[Crypto] Monitor error ${pos.symbol}: ${(e.message || '').substring(0, 60)}`);
    }
  }
}

async function _executeSellPosition(cfg, pos, reason) {
  try {
    const ticker = await getTicker(pos.symbol);
    const tickerPrice = ticker?.last || pos.current_price || pos.entry_price;
    let sellPrice = tickerPrice;

    const keyInfo = _getApiKeyInfo(cfg);
    let sold = false;

    if (keyInfo) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const sellQty = formatAmount(pos.symbol, pos.quantity) || pos.quantity;
          const order = await createOrder(keyInfo.user_id, keyInfo.id, pos.symbol, 'sell', sellQty);
          sold = true;
          if (order?.average) sellPrice = order.average;
          else if (order?.price && order.price > 0) sellPrice = order.price;
          break;
        } catch (e) {
          const msg = e.message || '';

          if (msg.includes('NOTIONAL')) {
            console.warn(`[Crypto] ${pos.symbol} monto muy bajo para vender ($${(pos.quantity * tickerPrice).toFixed(2)}) — cerrando posición`);
            break;
          }

          if (msg.includes('insufficient') || msg.includes('balance')) {
            try {
              const bal = await getBalances(keyInfo.user_id, keyInfo.id);
              const coin = pos.symbol.split('/')[0];
              const realQty = bal[coin]?.free || 0;
              if (realQty > 0 && (realQty * tickerPrice) >= 5) {
                const adjQty = formatAmount(pos.symbol, realQty) || parseFloat(realQty.toFixed(6));
                console.log(`[Crypto] Vendiendo balance real: ${adjQty} ${coin} (posición decía ${pos.quantity})`);
                const order = await createOrder(keyInfo.user_id, keyInfo.id, pos.symbol, 'sell', adjQty);
                sold = true;
                if (order?.average) sellPrice = order.average;
                else if (order?.price && order.price > 0) sellPrice = order.price;
              } else {
                console.warn(`[Crypto] ${coin} real: ${realQty} (muy poco) — cerrando posición`);
              }
            } catch {}
            break;
          }

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

    // PnL con precio REAL de ejecución + fees de Binance (0.1% por lado)
    const grossPnl = (sellPrice - pos.entry_price) * pos.quantity;
    const buyFee = pos.entry_price * pos.quantity * 0.001;
    const sellFee = sold ? sellPrice * pos.quantity * 0.001 : 0;
    const totalFees = buyFee + sellFee;
    const netPnl = grossPnl - totalFees;

    // Actualizar current_price con el precio real de venta
    getDB().prepare('UPDATE crypto_positions SET current_price = ? WHERE id = ?').run(sellPrice, pos.id);

    // Siempre registrar PnL real (incluso si la venta falló)
    closePosition(pos.id, netPnl, sold ? reason : `Cerrada sin venta (${reason})`, sellPrice, totalFees);
    console.log(`[Crypto] ${sold ? '💰' : '📝'} SELL ${pos.symbol} x${pos.quantity} @ $${sellPrice} | PnL: $${netPnl.toFixed(2)} (fees: -$${totalFees.toFixed(2)}) | ${reason}`);

    if (_broadcastFn) _broadcastFn({
      type: 'crypto_sell', symbol: pos.symbol, quantity: pos.quantity,
      entry: pos.entry_price, exit: sellPrice, pnl: netPnl, reason,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`[Crypto] Error vendiendo ${pos.symbol}:`, e.message);
  }
}

// ── Sync: detectar criptos en Binance no trackeadas por el bot ────────────────
// Si el usuario compró manualmente (ej: XRP), el bot no sabe. Esta función
// escanea el balance de Binance y crea posiciones para monitorear/vender.

async function syncBinanceWallet() {
  const cfg = getConfig();
  const keyInfo = _getApiKeyInfo(cfg);
  if (!keyInfo) return;

  try {
    const balance = await getBalances(keyInfo.user_id, keyInfo.id);
    if (!balance) return;

    const openPositions = getOpenPositions();
    let synced = 0;

    for (const [coin, info] of Object.entries(balance)) {
      if (coin === 'USDT' || coin === 'ARS' || !info.total || info.total <= 0) continue;
      const symbol = coin + '/USDT';

      // Ya tiene posición abierta? → skip
      if (openPositions.some(p => p.symbol === symbol)) continue;

      // Obtener precio actual
      let price = 0;
      try { const t = await getTicker(symbol); price = t?.last || 0; } catch {}
      if (price <= 0) continue;

      const value = info.total * price;
      if (value < 6) continue; // Ignorar dust (<$6, Binance no deja vender <$5)

      // Crear posición de tracking con precio actual como entrada
      const sl = Math.round(price * (1 - (cfg.stop_loss_pct || 5) / 100) * 10000) / 10000;
      const tp = Math.round(price * (1 + (cfg.take_profit_pct || 15) / 100) * 10000) / 10000;
      const qty = info.total;

      savePosition({
        symbol, side: 'BUY', quantity: qty, entry_price: price,
        stop_loss: sl, take_profit: tp, status: 'OPEN',
        order_id: 'SYNC-' + Date.now(), reason: `Sincronizado desde wallet Binance ($${value.toFixed(2)})`,
      });
      synced++;
      console.log(`[Crypto] 🔄 SYNC ${symbol}: ${qty} @ $${price} (~$${value.toFixed(2)}) | SL:$${sl} TP:$${tp}`);
    }

    if (synced > 0) console.log(`[Crypto] 🔄 ${synced} criptos sincronizadas desde Binance`);
  } catch (e) {
    console.error('[Crypto] Sync error:', e.message);
  }
}

// ── Sniper de Nuevos Listings ─────────────────────────────────────────────────
// Detecta criptos recién listadas en Binance. Suelen subir fuerte las primeras horas.

const _sniperBought = new Set(); // Evitar comprar el mismo listing 2 veces

async function sniperNewListings() {
  const cfg = getConfig();
  if (!cfg.enabled) return;

  try {
    const newListings = await checkNewListings();
    if (!newListings.length) return;

    for (const listing of newListings) {
      // Ya compramos este listing? Skip
      if (_sniperBought.has(listing.symbol)) continue;

      console.log(`[Crypto] 🚀 SNIPER: Nuevo listing ${listing.symbol} @ $${listing.price} | Vol: $${Math.round(listing.volume / 1e6)}M`);

      // Verificar volumen mínimo (evitar scams sin liquidez)
      if (listing.volume < 500000) {
        console.log(`[Crypto] 🚀 Skip ${listing.symbol} — volumen muy bajo ($${Math.round(listing.volume)})`);
        continue;
      }

      // No comprar si ya tenemos posición
      const positions = getOpenPositions();
      if (positions.some(p => p.symbol === listing.symbol)) continue;
      if (positions.length >= 3) {
        console.log(`[Crypto] 🚀 Skip ${listing.symbol} — ya hay ${positions.length} posiciones abiertas`);
        continue;
      }

      const keyInfo = _getApiKeyInfo(cfg);
      if (!keyInfo) continue;

      // Max $10 en listings nuevos (conservador)
      const tradeAmount = Math.min(cfg.max_per_trade_usd || 10, 10);
      try {
        const { order, price, quantity } = await _executeTrade(cfg, listing.symbol, 'buy', tradeAmount);
        const sl = Math.round(price * 0.92 * 100000) / 100000;  // -8% SL
        const tp = Math.round(price * 1.30 * 100000) / 100000;  // +30% TP
        savePosition({
          symbol: listing.symbol, side: 'BUY', quantity, entry_price: price,
          stop_loss: sl, take_profit: tp, status: 'OPEN',
          order_id: 'SNIPER-' + (order?.id || Date.now()),
          reason: `🚀 Nuevo listing detectado — Vol: $${Math.round(listing.volume / 1e6)}M`,
        });
        _sniperBought.add(listing.symbol);
        console.log(`[Crypto] 🚀 BUY ${listing.symbol}: ${quantity} @ $${price} | SL:$${sl}(-8%) TP:$${tp}(+30%)`);
      } catch (e) {
        console.error(`[Crypto] 🚀 Error sniper ${listing.symbol}: ${(e.message || '').substring(0, 60)}`);
      }
    }
  } catch (e) {
    console.error('[Crypto] Sniper error:', (e.message || '').substring(0, 60));
  }
}

// ── Init / Control ────────────────────────────────────────────────────────────

let _sniperTimer = null;

function init(broadcastFn) {
  _broadcastFn = broadcastFn;
  const cfg = getConfig();
  const intervalMs = (cfg.analysis_interval_min || 3) * 60 * 1000;

  if (_timer) clearInterval(_timer);
  if (_monitorTimer) clearInterval(_monitorTimer);
  if (_sniperTimer) clearInterval(_sniperTimer);

  _timer = setInterval(async () => {
    try { await runAnalysis(); } catch (e) { console.error('[Crypto]', e.message); }
  }, intervalMs);

  _monitorTimer = setInterval(async () => {
    try { await monitorPositions(); } catch (e) { console.error('[Crypto] Monitor:', e.message); }
  }, 30 * 1000);

  // Sniper: detectar nuevos listings cada 1 minuto
  _sniperTimer = setInterval(async () => {
    try { await sniperNewListings(); } catch (e) { console.error('[Crypto] Sniper:', e.message); }
  }, 60 * 1000);

  console.log(`[Crypto] Iniciado — AI cada ${cfg.analysis_interval_min || 3}min, monitor 30s, sniper 1min`);

  // Primer análisis (15s para que cargue todo)
  setTimeout(async () => {
    try { await runAnalysis(); } catch (e) { console.error('[Crypto] Inicial:', e.message); }
  }, 15000);
}

function getStatus() {
  const cfg = getConfig();
  // Excluir posiciones PAPER del status
  const positions = getOpenPositions().filter(p => !p.order_id || !p.order_id.startsWith('PAPER'));
  return {
    enabled: !!cfg.enabled,
    openPositions: positions.length,
    positions: positions.map(p => {
      const current = p.current_price || p.entry_price;
      const pnlPct = current > 0 && p.entry_price > 0
        ? (((current - p.entry_price) / p.entry_price) * 100).toFixed(1) + '%'
        : 'N/A';
      return {
        symbol: p.symbol, qty: p.quantity, entry: p.entry_price,
        current, sl: p.stop_loss, tp: p.take_profit, side: p.side, pnlPct,
        mode: 'LIVE',
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
