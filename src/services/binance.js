const ccxt = require('ccxt');
const https = require('https');
const { decrypt } = require('./encryption');
const { getDB } = require('../models/db');

// ── HTTP helper ──

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'identity',
        'User-Agent': 'AutoTrader/1.0'
      }
    };
    https.get(url, opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ── Simple in-memory cache ──

const cache = {};
const CACHE_TTL = 60000; // 60 seconds

async function cachedFetch(key, url, ttl) {
  const now = Date.now();
  if (cache[key] && (now - cache[key].ts) < (ttl || CACHE_TTL)) {
    return cache[key].data;
  }
  const data = await fetchJSON(url);
  cache[key] = { data, ts: now };
  return data;
}

// ── CoinGecko ID mapping ──

const COINGECKO_IDS = {
  'BTC': 'bitcoin', 'ETH': 'ethereum', 'BNB': 'binancecoin',
  'SOL': 'solana', 'XRP': 'ripple', 'ADA': 'cardano',
  'DOGE': 'dogecoin', 'MATIC': 'matic-network', 'DOT': 'polkadot',
  'AVAX': 'avalanche-2', 'LINK': 'chainlink', 'UNI': 'uniswap',
  'SHIB': 'shiba-inu', 'LTC': 'litecoin', 'TRX': 'tron',
  'ATOM': 'cosmos', 'FIL': 'filecoin', 'APT': 'aptos',
  'NEAR': 'near-protocol', 'ARB': 'arbitrum',
};

function getGeckoId(symbol) {
  const base = symbol.split('/')[0];
  return COINGECKO_IDS[base] || base.toLowerCase();
}

// ── Exchange (ccxt) ──

const SUPPORTED_EXCHANGES = ['bybit', 'binance', 'kucoin', 'okx', 'bitget'];

function createExchange(apiKeyRow) {
  const apiKey = decrypt(apiKeyRow.api_key_enc);
  const secret = decrypt(apiKeyRow.api_secret_enc);
  const exchangeName = apiKeyRow.exchange || 'bybit';
  const ExchangeClass = ccxt[exchangeName];
  if (!ExchangeClass) throw new Error('Exchange no soportado: ' + exchangeName);

  const config = {
    apiKey,
    secret,
    enableRateLimit: true,
    options: { defaultType: 'spot' },
  };

  // Binance: usar endpoint alternativo que no bloquea IPs de datacenter
  if (exchangeName === 'binance') {
    config.options = {
      ...config.options,
      defaultType: 'spot',
      adjustForTimeDifference: true,
    };
    // Override solo los hostnames, ccxt arma las rutas
    config.hostname = 'data-api.binance.vision';
    // Proxy adicional si está configurado
    if (process.env.BINANCE_PROXY) {
      const proxy = process.env.BINANCE_PROXY;
      if (proxy.startsWith('socks')) config.socksProxy = proxy;
      else config.httpsProxy = proxy;
    }
  }

  return new ExchangeClass(config);
}

function getExchangeForUser(userId, apiKeyId) {
  const db = getDB();
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?').get(apiKeyId, userId);
  if (!row) throw new Error('API key not found');
  return createExchange(row);
}

async function getBalances(userId, apiKeyId) {
  const exchange = getExchangeForUser(userId, apiKeyId);
  const balance = await exchange.fetchBalance();
  const assets = {};
  for (const [coin, info] of Object.entries(balance.total)) {
    if (info > 0) assets[coin] = { total: info, free: balance.free[coin] || 0, used: balance.used[coin] || 0 };
  }
  return assets;
}

// ── Market data via CoinGecko (with cache to avoid rate limits) ──

async function getTicker(pair) {
  const id = getGeckoId(pair);
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=' + id + '&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true';
  const json = await cachedFetch('ticker_' + id, url, 30000);
  const d = json[id] || {};
  return {
    symbol: pair,
    last: d.usd || 0,
    percentage: d.usd_24h_change || 0,
    quoteVolume: d.usd_24h_vol || 0,
  };
}

async function getOHLCV(pair, timeframe, limit) {
  const id = getGeckoId(pair);
  const days = timeframe === '1d' ? limit : timeframe === '4h' ? Math.ceil(limit / 6) : timeframe === '1h' ? Math.ceil(limit / 24) : Math.ceil(limit / 288);
  const clampedDays = Math.min(days, 90);
  const url = 'https://api.coingecko.com/api/v3/coins/' + id + '/market_chart?vs_currency=usd&days=' + clampedDays;
  const json = await cachedFetch('ohlcv_' + id + '_' + clampedDays, url, 120000);
  if (!json.prices) return [];
  return json.prices.map(p => [p[0], p[1], p[1], p[1], p[1], 0]);
}

async function createOrder(userId, apiKeyId, pair, side, amount) {
  const exchange = getExchangeForUser(userId, apiKeyId);
  return exchange.createMarketOrder(pair, side, amount);
}

async function testConnection(userId, apiKeyId) {
  const exchange = getExchangeForUser(userId, apiKeyId);
  try {
    const balance = await exchange.fetchBalance();
    return { success: true, totalAssets: Object.keys(balance.total).filter(k => balance.total[k] > 0).length };
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('restricted location') || msg.includes('Service unavailable') || msg.includes('451')) {
      // Binance bloquea esta IP — verificar que la API key es válida con endpoint público
      try {
        await exchange.fetchTicker('BTC/USDT');
        return { success: true, totalAssets: -1, warning: 'Binance bloquea esta IP para datos privados. API key parece válida. Se requiere proxy o VPS fuera de USA.' };
      } catch {
        throw new Error('Binance bloquea la IP del servidor (datacenter USA). Necesitás un VPS fuera de USA o un proxy.');
      }
    }
    throw e;
  }
}

async function getTopPairs() {
  const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false&price_change_percentage=24h';
  const json = await cachedFetch('top_pairs', url, 60000);
  if (!Array.isArray(json)) return [];
  return json.map(c => ({
    symbol: (c.symbol || '').toUpperCase() + '/USDT',
    price: c.current_price || 0,
    change24h: c.price_change_percentage_24h || 0,
    volume: c.total_volume || 0,
    high: c.high_24h || 0,
    low: c.low_24h || 0,
  }));
}

module.exports = { getBalances, getTicker, getOHLCV, createOrder, testConnection, getExchangeForUser, getTopPairs, SUPPORTED_EXCHANGES };