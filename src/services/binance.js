const ccxt = require('ccxt');
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
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

  // Binance: proxy SOCKS para bypass geo-block (túnel SSH desde PC argentina)
  if (exchangeName === 'binance') {
    config.options = {
      ...config.options,
      defaultType: 'spot',
      adjustForTimeDifference: true,
      fetchCurrencies: false,
      recvWindow: 60000,
    };
    if (process.env.BINANCE_PROXY) {
      const proxy = process.env.BINANCE_PROXY;
      const proxyUrl = proxy.replace('socks5h://', 'socks5://');
      if (proxy.startsWith('socks')) {
        config.socksProxy = proxyUrl;
        const agent = new SocksProxyAgent(proxyUrl);
        config.httpAgent = agent;
        config.httpsAgent = agent;
      } else {
        config.httpsProxy = proxy;
      }
    }
  }

  const exchange = new ExchangeClass(config);
  // Force agent on instance for maximum compatibility
  if (exchangeName === 'binance' && process.env.BINANCE_PROXY && process.env.BINANCE_PROXY.startsWith('socks')) {
    const proxyUrl = process.env.BINANCE_PROXY.replace('socks5h://', 'socks5://');
    const agent = new SocksProxyAgent(proxyUrl);
    exchange.httpAgent = agent;
    exchange.httpsAgent = agent;
  }
  return exchange;
}

function getExchangeForUser(userId, apiKeyId) {
  const db = getDB();
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?').get(apiKeyId, userId);
  if (!row) throw new Error('API key not found');
  return createExchange(row);
}

async function getBalances(userId, apiKeyId) {
  const exchange = getExchangeForUser(userId, apiKeyId);
  exchange.options.fetchCurrencies = false;
  const balance = await exchange.fetchBalance({ type: 'spot' });
  const assets = {};
  for (const [coin, info] of Object.entries(balance.total)) {
    if (info > 0) assets[coin] = { total: info, free: balance.free[coin] || 0, used: balance.used[coin] || 0 };
  }
  return assets;
}

// ── Shared exchange for public data (tickers, without API keys) ──

let _sharedExchange = null;
let _sharedExchangeTs = 0;

function _getSharedExchange() {
  const now = Date.now();
  if (_sharedExchange && (now - _sharedExchangeTs) < 300000) return _sharedExchange;
  const config = { enableRateLimit: true, options: { defaultType: 'spot' } };
  if (process.env.BINANCE_PROXY) {
    const proxy = process.env.BINANCE_PROXY;
    const proxyUrl = proxy.replace('socks5h://', 'socks5://');
    if (proxy.startsWith('socks')) {
      config.socksProxy = proxyUrl;
      const agent = new SocksProxyAgent(proxyUrl);
      config.httpAgent = agent;
      config.httpsAgent = agent;
    }
  }
  _sharedExchange = new ccxt.binance(config);
  if (process.env.BINANCE_PROXY && process.env.BINANCE_PROXY.startsWith('socks')) {
    const proxyUrl = process.env.BINANCE_PROXY.replace('socks5h://', 'socks5://');
    const agent = new SocksProxyAgent(proxyUrl);
    _sharedExchange.httpAgent = agent;
    _sharedExchange.httpsAgent = agent;
  }
  _sharedExchangeTs = now;
  return _sharedExchange;
}

// ── Market data: Binance via proxy first, CoinGecko fallback ──

async function getTicker(pair) {
  // Try Binance exchange via proxy
  try {
    const exchange = _getSharedExchange();
    const ticker = await exchange.fetchTicker(pair);
    if (ticker && ticker.last > 0) {
      return { symbol: pair, last: ticker.last, percentage: ticker.percentage || 0, quoteVolume: ticker.quoteVolume || 0 };
    }
  } catch {}
  // Fallback: CoinGecko
  const id = getGeckoId(pair);
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=' + id + '&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true';
  const json = await cachedFetch('ticker_' + id, url, 30000);
  const d = json[id] || {};
  return { symbol: pair, last: d.usd || 0, percentage: d.usd_24h_change || 0, quoteVolume: d.usd_24h_vol || 0 };
}

async function getOHLCV(pair, timeframe, limit) {
  // Try Binance exchange via proxy
  try {
    const exchange = _getSharedExchange();
    return await exchange.fetchOHLCV(pair, timeframe, undefined, limit || 100);
  } catch {}
  // Fallback: CoinGecko
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
  exchange.options.fetchCurrencies = false;
  try {
    const balance = await exchange.fetchBalance({ type: 'spot' });
    return { success: true, totalAssets: Object.keys(balance.total).filter(k => balance.total[k] > 0).length };
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('-2008') || msg.includes('Invalid Api-Key')) {
      throw new Error('API Key inválida o expirada en Binance. Creá una nueva en binance.com y actualizala acá.');
    }
    if (msg.includes('-2015') || msg.includes('Invalid API-key, IP')) {
      throw new Error('IP no autorizada. Tu API key está restringida a una IP diferente. Actualizá la restricción de IP en Binance.');
    }
    if (msg.includes('restricted location') || msg.includes('Service unavailable') || msg.includes('451')) {
      try {
        await exchange.fetchTicker('BTC/USDT');
        return { success: true, totalAssets: -1, warning: 'Binance bloquea esta IP para datos privados. Se requiere proxy SOCKS.' };
      } catch {
        throw new Error('Binance bloquea la IP del servidor. Verificá que el túnel SSH esté activo.');
      }
    }
    throw e;
  }
}

async function resaveApiKey(apiKey, apiSecret) {
  const db = getDB();
  const { encrypt } = require('./encryption');
  const encKey = encrypt(apiKey);
  const encSecret = encrypt(apiSecret);
  const row = db.prepare("SELECT id FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
  if (row) {
    db.prepare('UPDATE api_keys SET api_key_enc = ?, api_secret_enc = ? WHERE id = ?').run(encKey, encSecret, row.id);
    return { id: row.id, updated: true };
  }
  const r = db.prepare('INSERT INTO api_keys (user_id, exchange, label, api_key_enc, api_secret_enc, permissions) VALUES (?,?,?,?,?,?)')
    .run(1, 'binance', 'autotrader', encKey, encSecret, 'spot');
  return { id: r.lastInsertRowid, updated: false };
}

async function getTopPairs() {
  const TOP = ['BTC/USDT','ETH/USDT','BNB/USDT','SOL/USDT','XRP/USDT','ADA/USDT','DOGE/USDT','AVAX/USDT','LINK/USDT','DOT/USDT','SHIB/USDT','LTC/USDT','TRX/USDT','ATOM/USDT','UNI/USDT','NEAR/USDT','ARB/USDT','APT/USDT','FIL/USDT','MATIC/USDT'];
  // Try Binance exchange via proxy
  try {
    const exchange = _getSharedExchange();
    const tickers = await exchange.fetchTickers(TOP);
    return Object.values(tickers).map(t => ({
      symbol: t.symbol, price: t.last || 0, change24h: t.percentage || 0,
      volume: t.quoteVolume || 0, high: t.high || 0, low: t.low || 0,
    }));
  } catch {}
  // Fallback: CoinGecko
  const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false&price_change_percentage=24h';
  const json = await cachedFetch('top_pairs', url, 60000);
  if (!Array.isArray(json)) return [];
  return json.map(c => ({
    symbol: (c.symbol || '').toUpperCase() + '/USDT',
    price: c.current_price || 0, change24h: c.price_change_percentage_24h || 0,
    volume: c.total_volume || 0, high: c.high_24h || 0, low: c.low_24h || 0,
  }));
}

async function getFirstBinanceBalance() {
  const db = getDB();
  const row = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
  if (!row) return null;

  // Method 1: ccxt fetchBalance (spot only, no SAPI)
  try {
    const exchange = createExchange(row);
    exchange.options.fetchCurrencies = false;
    const balance = await exchange.fetchBalance({ type: 'spot' });
    const assets = {};
    for (const [coin, info] of Object.entries(balance.total)) {
      if (info > 0) assets[coin] = { total: info, free: balance.free[coin] || 0, used: balance.used[coin] || 0 };
    }
    return assets;
  } catch (e1) {
    console.log('[Binance] ccxt fetchBalance failed:', (e1.message || '').substring(0, 120));
  }

  // Method 2: Direct signed HTTP to /api/v3/account
  try {
    return await _directBalance(row);
  } catch (e2) {
    console.log('[Binance] direct balance failed:', (e2.message || '').substring(0, 120));
    throw new Error('No se pudo obtener balance de Binance: ' + (e2.message || '').substring(0, 100));
  }
}

async function _directBalance(apiKeyRow) {
  const nodeCrypto = require('crypto');
  const apiKey = decrypt(apiKeyRow.api_key_enc);
  const secret = decrypt(apiKeyRow.api_secret_enc);

  // Get Binance server time first to avoid timestamp issues
  const serverTime = await _getBinanceTime();
  const params = 'timestamp=' + serverTime + '&recvWindow=60000';
  const sig = nodeCrypto.createHmac('sha256', secret).update(params).digest('hex');
  const url = 'https://api.binance.com/api/v3/account?' + params + '&signature=' + sig;

  console.log('[Binance] Direct balance: key=' + apiKey.substring(0, 8) + '... serverTime=' + serverTime);

  return new Promise((resolve, reject) => {
    const reqOpts = {
      headers: { 'X-MBX-APIKEY': apiKey },
    };
    if (process.env.BINANCE_PROXY && process.env.BINANCE_PROXY.startsWith('socks')) {
      const proxyUrl = process.env.BINANCE_PROXY.replace('socks5h://', 'socks5://');
      reqOpts.agent = new SocksProxyAgent(proxyUrl);
    }
    https.get(url, reqOpts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          console.log('[Binance] Direct balance response code:', j.code || 'OK', j.msg || '');
          if (j.code) return reject(new Error('Binance: ' + j.msg + ' (' + j.code + ')'));
          const assets = {};
          for (const b of (j.balances || [])) {
            const free = parseFloat(b.free || 0);
            const locked = parseFloat(b.locked || 0);
            const total = free + locked;
            if (total > 0) assets[b.asset] = { total, free, used: locked };
          }
          resolve(assets);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function _getBinanceTime() {
  return new Promise((resolve, reject) => {
    const reqOpts = {};
    if (process.env.BINANCE_PROXY && process.env.BINANCE_PROXY.startsWith('socks')) {
      const proxyUrl = process.env.BINANCE_PROXY.replace('socks5h://', 'socks5://');
      reqOpts.agent = new SocksProxyAgent(proxyUrl);
    }
    https.get('https://api.binance.com/api/v3/time', reqOpts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve(j.serverTime || Date.now());
        } catch { resolve(Date.now()); }
      });
    }).on('error', () => resolve(Date.now()));
  });
}

module.exports = { getBalances, getTicker, getOHLCV, createOrder, testConnection, getExchangeForUser, getTopPairs, getFirstBinanceBalance, resaveApiKey, SUPPORTED_EXCHANGES };