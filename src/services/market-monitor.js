// src/services/market-monitor.js
// Monitorea precios en tiempo real, calcula indicadores técnicos, gestiona watchlist

const { getDB }  = require('../models/db');
const cocos      = require('./cocos');

const POLL_MS      = 30 * 1000;  // 30 segundos
const HISTORY_DAYS = 30;         // días de historia para indicadores

let _broadcastFn = null;
let _pollTimer   = null;
let _running     = false;

// ── Watchlist por defecto ─────────────────────────────────────────────────────

const DEFAULT_WATCHLIST = [
  // ── Energía / Petróleo ──
  { ticker: 'YPFD',  instrument_type: 'ACCIONES', segment: 'C', currency: 'ARS' },
  { ticker: 'PAMP',  instrument_type: 'ACCIONES', segment: 'C', currency: 'ARS' },
  { ticker: 'TGNO4', instrument_type: 'ACCIONES', segment: 'C', currency: 'ARS' },
  { ticker: 'TGSU2', instrument_type: 'ACCIONES', segment: 'C', currency: 'ARS' },
  { ticker: 'CEPU',  instrument_type: 'ACCIONES', segment: 'C', currency: 'ARS' },
  // ── Bancos / Finanzas ──
  { ticker: 'GGAL',  instrument_type: 'ACCIONES', segment: 'C', currency: 'ARS' },
  { ticker: 'BBAR',  instrument_type: 'ACCIONES', segment: 'C', currency: 'ARS' },
  { ticker: 'BMA',   instrument_type: 'ACCIONES', segment: 'C', currency: 'ARS' },
  { ticker: 'SUPV',  instrument_type: 'ACCIONES', segment: 'C', currency: 'ARS' },
  // ── Materiales / Industria ──
  { ticker: 'ALUA',  instrument_type: 'ACCIONES', segment: 'C', currency: 'ARS' },
  { ticker: 'LOMA',  instrument_type: 'ACCIONES', segment: 'C', currency: 'ARS' },
  { ticker: 'TXAR',  instrument_type: 'ACCIONES', segment: 'C', currency: 'ARS' },
  // ── Telecom / Tech local ──
  { ticker: 'TECO2', instrument_type: 'ACCIONES', segment: 'C', currency: 'ARS' },
  // ── CEDEARs Tecnología ──
  { ticker: 'AAPL',  instrument_type: 'CEDEARS',  segment: 'C', currency: 'ARS' },
  { ticker: 'MSFT',  instrument_type: 'CEDEARS',  segment: 'C', currency: 'ARS' },
  { ticker: 'GOOGL', instrument_type: 'CEDEARS',  segment: 'C', currency: 'ARS' },
  { ticker: 'NVDA',  instrument_type: 'CEDEARS',  segment: 'C', currency: 'ARS' },
  { ticker: 'META',  instrument_type: 'CEDEARS',  segment: 'C', currency: 'ARS' },
  { ticker: 'AMZN',  instrument_type: 'CEDEARS',  segment: 'C', currency: 'ARS' },
  { ticker: 'TSLA',  instrument_type: 'CEDEARS',  segment: 'C', currency: 'ARS' },
  // ── CEDEARs Energía ──
  { ticker: 'XOM',   instrument_type: 'CEDEARS',  segment: 'C', currency: 'ARS' },
  { ticker: 'CVX',   instrument_type: 'CEDEARS',  segment: 'C', currency: 'ARS' },
  // ── CEDEARs Latam ──
  { ticker: 'MELI',  instrument_type: 'CEDEARS',  segment: 'C', currency: 'ARS' },
];

// ── DB helpers ────────────────────────────────────────────────────────────────

function initWatchlist() {
  const db   = getDB();
  const stmt = db.prepare('INSERT OR IGNORE INTO watchlist (ticker, instrument_type, segment, currency) VALUES (?,?,?,?)');
  for (const w of DEFAULT_WATCHLIST) stmt.run(w.ticker, w.instrument_type, w.segment, w.currency);
}

function getActiveWatchlist() {
  return getDB().prepare('SELECT * FROM watchlist WHERE active = 1').all();
}

function savePrice(ticker, price, variation, volume, open, high, low) {
  getDB().prepare(`
    INSERT INTO market_prices (ticker, price, variation, volume, open_price, high_price, low_price)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(ticker, price, variation || 0, volume || 0, open || 0, high || 0, low || 0);
}

function getPriceHistory(ticker, days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return getDB().prepare(
    'SELECT price, variation, timestamp FROM market_prices WHERE ticker = ? AND timestamp >= ? ORDER BY timestamp ASC'
  ).all(ticker, since);
}

function getLatestPrice(ticker) {
  return getDB().prepare(
    'SELECT * FROM market_prices WHERE ticker = ? ORDER BY timestamp DESC LIMIT 1'
  ).get(ticker);
}

function getAllLatestPrices() {
  return getDB().prepare(`
    SELECT mp.* FROM market_prices mp
    INNER JOIN (
      SELECT ticker, MAX(timestamp) as max_ts FROM market_prices GROUP BY ticker
    ) latest ON mp.ticker = latest.ticker AND mp.timestamp = latest.max_ts
  `).all();
}

// ── Indicadores técnicos ──────────────────────────────────────────────────────

function calcSMA(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((s, p) => s + p, 0) / period;
}

function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const changes = prices.slice(-period - 1).map((p, i, arr) => i > 0 ? p - arr[i - 1] : 0).slice(1);
  const gains   = changes.map(c => c > 0 ? c : 0);
  const losses  = changes.map(c => c < 0 ? -c : 0);
  const avgGain = gains.reduce((s, g) => s + g, 0) / period;
  const avgLoss = losses.reduce((s, l) => s + l, 0) / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round(100 - 100 / (1 + rs));
}

function calcMACD(prices) {
  if (prices.length < 26) return null;
  const ema12 = calcEMA(prices, 12);
  const ema26 = calcEMA(prices, 26);
  if (!ema12 || !ema26) return null;
  return Math.round((ema12 - ema26) * 100) / 100;
}

function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((s, p) => s + p, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function getIndicators(ticker) {
  const history  = getPriceHistory(ticker, HISTORY_DAYS);
  const priceArr = history.map(h => h.price);
  if (priceArr.length < 2) return null;

  const latest = priceArr[priceArr.length - 1];
  const sma20  = calcSMA(priceArr, 20);
  const sma50  = calcSMA(priceArr, 50);
  const rsi    = calcRSI(priceArr, 14);
  const macd   = calcMACD(priceArr);

  // Tendencia simple: % cambio últimos 5 registros
  const prev5 = priceArr.length >= 5 ? priceArr[priceArr.length - 5] : priceArr[0];
  const trend5 = prev5 > 0 ? ((latest - prev5) / prev5 * 100).toFixed(2) : 0;

  return { price: latest, sma20, sma50, rsi, macd, trend5: parseFloat(trend5), dataPoints: priceArr.length };
}

// ── Polling ───────────────────────────────────────────────────────────────────

function parseItem(item) {
  // Acepta todos los campos posibles de la API Cocos
  const price    = item.last_price || item.close_price || item.previous_close_price
                || item.previous_close || item.close || item.price || 0;
  const variation= item.variation  || item.daily_variation || item.price_change_percentage
                || item.price_change_pct || item.var || 0;
  const volume   = item.volume     || item.traded_volume   || item.volume_nominal || 0;
  const open     = item.open_price || item.open || 0;
  const high     = item.high_price || item.high || 0;
  const low      = item.low_price  || item.low  || 0;
  return { price, variation, volume, open, high, low };
}

async function pollOnce() {
  if (!cocos.isReady()) return;
  const watchlist = getActiveWatchlist();
  const results   = [];

  // ── Estrategia 1: batch por lista (funciona con mercado abierto Y cerrado) ──
  try {
    console.log('[Market] Iniciando batch poll...');
    const [accR, cdrR] = await Promise.allSettled([
      cocos.getMarketList('ACCIONES', 'LIDERES', '24hs', 'ARS', 'C', 1, 100),
      cocos.getMarketList('CEDEARS',  'CEDEARS', '24hs', 'ARS', 'C', 1, 100),
    ]);

    console.log('[Market] accR:', accR.status, accR.status==='fulfilled' ? JSON.stringify(accR.value).substring(0,200) : accR.reason?.message);
    console.log('[Market] cdrR:', cdrR.status, cdrR.status==='fulfilled' ? JSON.stringify(cdrR.value).substring(0,200) : cdrR.reason?.message);

    const byTicker = {};
    for (const r of [accR, cdrR]) {
      if (r.status !== 'fulfilled') continue;
      const items = Array.isArray(r.value) ? r.value : (r.value?.data || []);
      for (const item of items) {
        const tk = item.instrument_code || item.symbol || item.ticker;
        if (tk) byTicker[tk] = item;
      }
    }

    for (const w of watchlist) {
      const item = byTicker[w.ticker];
      if (!item) continue;
      const { price, variation, volume, open, high, low } = parseItem(item);
      if (price > 0) {
        savePrice(w.ticker, price, variation, volume, open, high, low);
        results.push({ ticker: w.ticker, price, variation, volume, indicators: getIndicators(w.ticker) });
      }
    }

    if (results.length > 0) {
      if (_broadcastFn) _broadcastFn({ type: 'market_update', data: results, timestamp: new Date().toISOString() });
      console.log(`[Market] Batch actualizado: ${results.length} tickers`);
      return results;
    }
  } catch (e) {
    console.error('[Market] Error batch poll:', e.message);
  }

  // ── Estrategia 2: quote individual por ticker (fallback) ──
  let debugLogged = false;
  for (const item of watchlist) {
    try {
      const longTicker = `${item.ticker}-0002-${item.segment}-CT-${item.currency}`;
      const quote = await cocos.getQuote(longTicker, item.segment);
      if (!debugLogged) { console.log('[Market] Quote sample:', JSON.stringify(quote).substring(0, 400)); debugLogged = true; }
      const { price, variation, volume, open, high, low } = parseItem(quote || {});
      if (price > 0) {
        savePrice(item.ticker, price, variation, volume, open, high, low);
        results.push({ ticker: item.ticker, price, variation, volume, indicators: getIndicators(item.ticker) });
      }
    } catch (e) { if (!debugLogged) { console.error('[Market] Quote error:', e.message); debugLogged = true; } }
    await new Promise(r => setTimeout(r, 200));
  }

  if (results.length > 0 && _broadcastFn) {
    _broadcastFn({ type: 'market_update', data: results, timestamp: new Date().toISOString() });
  }
  return results;
}

// ── API pública ───────────────────────────────────────────────────────────────

function init(broadcastFn) {
  _broadcastFn = broadcastFn;
  initWatchlist();

  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(async () => {
    try { await pollOnce(); } catch (e) { console.error('[Market] Poll error:', e.message); }
  }, POLL_MS);

  _running = true;
  console.log('[Market] Monitor iniciado — polling cada 30s');
  pollOnce().catch(() => {}); // primer poll inmediato
}

function addToWatchlist(ticker, type, segment, currency) {
  try {
    getDB().prepare(
      'INSERT OR REPLACE INTO watchlist (ticker, instrument_type, segment, currency, active) VALUES (?,?,?,?,1)'
    ).run(ticker.toUpperCase(), type || 'ACCIONES', segment || 'C', currency || 'ARS');
    return true;
  } catch { return false; }
}

function removeFromWatchlist(ticker) {
  getDB().prepare('UPDATE watchlist SET active = 0 WHERE ticker = ?').run(ticker.toUpperCase());
}

module.exports = {
  init,
  getActiveWatchlist,
  getAllLatestPrices,
  getLatestPrice,
  getPriceHistory,
  getIndicators,
  addToWatchlist,
  removeFromWatchlist,
  pollOnce,
};
