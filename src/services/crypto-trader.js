// src/services/crypto-trader.js
// AI Crypto Trader — Binance 24/7, 100% separado de Cocos
// Usa: binance.js (órdenes), news-fetcher (noticias), ai-token (OpenAI), rag (contexto)

const { getDB }          = require('../models/db');
const { getOpenAIToken } = require('./ai-token');
const { getBalances, getTicker, getTopPairs, getTopGainers, checkNewListings, createOrder, getExchangeForUser, getMarketInfo, formatAmount } = require('./binance');
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
  // Buscar primera API key de Binance disponible
  const row = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
  return row || null;
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
      const pairPrice = currentPrices[coin + '/USDT'] || 0;
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

  // Invertir 50% del USDT disponible en cada top gainer (2 posiciones = 100%)
  // Usar availableUSDT (lo que realmente podemos gastar), no totalPortfolio
  const positionSize = Math.max(10, Math.floor(availableUSDT * 0.50));

  // Prompt: invertir en top gainers, PROHIBIDO vender para rotar
  const prompt = `CRYPTO TRADER — Binance Spot — REGLAS ESTRICTAS

MERCADO:
${marketCtx}

BALANCE: ${balanceCtx} | USDT libre: $${availableUSDT.toFixed(0)} | Portfolio total: ~$${totalPortfolio.toFixed(0)} | Invertir ~$${positionSize} por operación

POSICIONES ABIERTAS: ${posCtx}

NOTICIAS: ${newsCtx}

REGLAS OBLIGATORIAS:
1. COMPRAR las 2 criptos con mayor subida 24h y volumen >$3M. Invertir ~$${positionSize} en cada una.
2. PROHIBIDO VENDER para "rotar capital". NUNCA dar señal SELL para liberar dinero y comprar otra cripto.
3. Solo dar SELL si la posición bajó más de -${cfg.stop_loss_pct || 3}% desde precio de entrada (stop-loss alcanzado).
4. Si hay posiciones abiertas en ganancia o recién compradas → HOLD. NO tocarlas.
5. Si no hay USDT libre suficiente para comprar → no dar BUY, solo HOLD.
6. amount_usd debe ser $${positionSize} por señal.
7. Confidence >0.80 solo para top gainers con volumen fuerte.

JSON:
{"signals":[{"symbol":"XXX/USDT","action":"BUY|SELL|HOLD","confidence":0.85,"amount_usd":${positionSize},"reason":"..."}],"analysis":"breve","market_sentiment":"BULLISH|BEARISH|NEUTRAL","watchlist":[]}`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: OPENAI_MODEL, temperature: 0.2, max_tokens: 800,
        messages: [
          { role: 'system', content: 'Eres un trader de criptomonedas profesional. Compras las criptos que más suben en 24h. NUNCA vendes una posición para rotar capital a otra cripto. Solo vendes si el stop-loss fue alcanzado. JSON válido siempre.' },
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
    for (const sig of buys) {
      const currentPositions = getOpenPositions();

      if (currentPositions.some(p => p.symbol === sig.symbol)) {
        console.log(`[Crypto] Skip ${sig.symbol} — ya tenemos posición abierta`);
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

      try {
        const { order, price, quantity } = await _executeTrade(cfg, sig.symbol, 'buy', tradeAmount);
        const sl = Math.round(price * (1 - cfg.stop_loss_pct / 100) * 10000) / 10000;
        const tp = Math.round(price * (1 + cfg.take_profit_pct / 100) * 10000) / 10000;
        savePosition({
          symbol: sig.symbol, side: 'BUY', quantity, entry_price: price,
          stop_loss: sl, take_profit: tp, status: 'OPEN',
          order_id: order?.id || '', reason: sig.reason,
        });
        console.log(`[Crypto] ✅ BUY ${sig.symbol}: ${quantity} @ $${price} | SL:$${sl} TP:$${tp}`);
        // Descontar del disponible para la siguiente compra
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

async function monitorPositions() {
  const cfg = getConfig();
  if (!cfg.enabled) return;

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

      // ── Trailing Stop dinámico (proteger ganancias) ──
      // Cuanto más ganamos, más subimos el stop-loss
      if (pnlPct > 2) {
        let newSL;
        if (pnlPct > 20)     newSL = pos.entry_price * 1.15;  // +20% → SL a +15% (asegurar)
        else if (pnlPct > 10) newSL = pos.entry_price * 1.07;  // +10% → SL a +7%
        else if (pnlPct > 5)  newSL = pos.entry_price * 1.03;  // +5%  → SL a +3%
        else if (pnlPct > 2)  newSL = pos.entry_price * 1.005; // +2%  → SL a +0.5% (no perder)

        newSL = Math.round(newSL * 10000) / 10000;
        if (newSL > pos.stop_loss) {
          getDB().prepare('UPDATE crypto_positions SET stop_loss = ? WHERE id = ?').run(newSL, pos.id);
          console.log(`[Crypto] 📊 Trailing ${pos.symbol}: +${pnlPct.toFixed(1)}% → SL subido a $${newSL} (+${(((newSL - pos.entry_price) / pos.entry_price) * 100).toFixed(1)}%)`);
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

// ── Sniper de Nuevos Listings ─────────────────────────────────────────────────
// Revisa cada 2 min si Binance listó una cripto nueva.
// Las criptos nuevas suelen subir 50-500%+ en las primeras horas.
// Compra apenas detecta → trailing stop agresivo para vender en el pico.

async function sniperNewListings() {
  const cfg = getConfig();
  if (!cfg.enabled) return;

  try {
    const newListings = await checkNewListings();
    if (!newListings.length) return;

    for (const listing of newListings) {
      console.log(`[Crypto] 🚀 SNIPER: Nuevo listing ${listing.symbol} @ $${listing.price} | Vol: $${Math.round(listing.volume / 1e6)}M`);

      // Verificar que tenga volumen mínimo (evitar scams sin liquidez)
      if (listing.volume < 500000) {
        console.log(`[Crypto] 🚀 Skip ${listing.symbol} — volumen muy bajo ($${Math.round(listing.volume)})`);
        continue;
      }

      // No comprar si ya tenemos posición
      const positions = getOpenPositions();
      if (positions.some(p => p.symbol === listing.symbol)) continue;

      // Comprar con monto conservador para nuevo listing
      const keyInfo = _getApiKeyInfo(cfg);
      if (!keyInfo) continue;

      const tradeAmount = Math.min(cfg.max_per_trade_usd || 10, 10); // Max $10 en listings nuevos
      try {
        const { order, price, quantity } = await _executeTrade(cfg, listing.symbol, 'buy', tradeAmount);
        // SL más ajustado (nuevo listing = volatilidad extrema)
        const sl = Math.round(price * 0.90 * 10000) / 10000;   // -10% SL (protección de caída)
        const tp = Math.round(price * 1.50 * 10000) / 10000;   // +50% TP (criptos nuevas suben fuerte)
        savePosition({
          symbol: listing.symbol, side: 'BUY', quantity, entry_price: price,
          stop_loss: sl, take_profit: tp, status: 'OPEN',
          order_id: order?.id || '', reason: `🚀 NUEVO LISTING detectado — compra automática sniper`,
        });
        console.log(`[Crypto] 🚀 LIVE BUY ${listing.symbol}: ${quantity} @ $${price} | SL:$${sl} TP:$${tp}`);
      } catch (e) {
        console.error(`[Crypto] 🚀 Error sniper ${listing.symbol}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Crypto] Sniper error:', e.message);
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

  // Sniper: revisa nuevos listings cada 2 minutos
  _sniperTimer = setInterval(async () => {
    try { await sniperNewListings(); } catch (e) { console.error('[Crypto] Sniper:', e.message); }
  }, 2 * 60 * 1000);

  console.log(`[Crypto] AI Trader iniciado — análisis cada ${cfg.analysis_interval_min || 3} min, monitor cada 30s, sniper cada 2min`);

  // Primer análisis inmediato (10s para que cargue todo)
  setTimeout(async () => {
    try { await runAnalysis(); } catch (e) { console.error('[Crypto] Inicial:', e.message); }
  }, 10000);
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
