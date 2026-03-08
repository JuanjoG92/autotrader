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
    timeout: 30000,
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
  const config = { enableRateLimit: true, timeout: 30000, options: { defaultType: 'spot' } };
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

// ── Market data: Binance only ──

async function getTicker(pair) {
  const exchange = _getSharedExchange();
  const ticker = await exchange.fetchTicker(pair);
  if (ticker && ticker.last > 0) {
    return { symbol: pair, last: ticker.last, percentage: ticker.percentage || 0, quoteVolume: ticker.quoteVolume || 0 };
  }
  throw new Error('Sin precio de Binance para ' + pair);
}

async function getOHLCV(pair, timeframe, limit) {
  const exchange = _getSharedExchange();
  return await exchange.fetchOHLCV(pair, timeframe, undefined, limit || 100);
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
  } catch (e) {
    console.error('[Binance] getTopPairs error:', (e.message || '').substring(0, 80));
    return [];
  }
}

// ── Top gainers: criptos que más suben en 24h (dinámico) ──
// Filtra: solo /USDT, volumen >$1M, precio >$0.01, cambio >0%
let _gainersCache = null;
let _gainersCacheTs = 0;
const GAINERS_CACHE_TTL = 5 * 60 * 1000; // 5 min cache

async function getTopGainers(limit) {
  const now = Date.now();
  if (_gainersCache && (now - _gainersCacheTs) < GAINERS_CACHE_TTL) {
    return _gainersCache.slice(0, limit || 10);
  }

  try {
    const exchange = _getSharedExchange();
    const allTickers = await exchange.fetchTickers();

    const gainers = Object.values(allTickers)
      .filter(t => {
        if (!t.symbol || !t.symbol.endsWith('/USDT')) return false;
        if (t.symbol.includes(':') || t.symbol.includes('UP/') || t.symbol.includes('DOWN/')) return false;
        if (!t.last || t.last <= 0.01) return false;
        if (!t.quoteVolume || t.quoteVolume < 1000000) return false; // >$1M volumen
        if (!t.percentage || t.percentage <= 0) return false;          // solo en alza
        return true;
      })
      .map(t => ({
        symbol: t.symbol,
        price: t.last,
        change24h: t.percentage || 0,
        volume: t.quoteVolume || 0,
        high: t.high || 0,
        low: t.low || 0,
      }))
      .sort((a, b) => b.change24h - a.change24h);

    _gainersCache = gainers;
    _gainersCacheTs = now;
    console.log(`[Binance] Top gainers: ${gainers.length} en alza, top5: ${gainers.slice(0, 5).map(g => g.symbol + ' +' + g.change24h.toFixed(1) + '%').join(', ')}`);
    return gainers.slice(0, limit || 10);
  } catch (e) {
    console.error('[Binance] getTopGainers error:', (e.message || '').substring(0, 80));
    return _gainersCache ? _gainersCache.slice(0, limit || 10) : [];
  }
}

// ── Balance cache (avoid slow proxy calls on every dashboard load) ──
let _balanceCache = null;
let _balanceCacheTs = 0;
const BALANCE_CACHE_TTL = 30000; // 30 seconds

async function getFirstBinanceBalance() {
  // Return cache if fresh
  if (_balanceCache && (Date.now() - _balanceCacheTs) < BALANCE_CACHE_TTL) {
    return _balanceCache;
  }

  const db = getDB();
  const row = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
  if (!row) return null;

  // Method 1: Direct signed HTTP (most reliable)
  try {
    const result = await _directBalance(row);
    _balanceCache = result;
    _balanceCacheTs = Date.now();
    return result;
  } catch (e1) {
    console.log('[Binance] direct balance failed:', (e1.message || '').substring(0, 120));
  }

  // Method 2: ccxt fetchBalance
  try {
    const exchange = createExchange(row);
    exchange.options.fetchCurrencies = false;
    const balance = await exchange.fetchBalance({ type: 'spot' });
    const assets = {};
    for (const [coin, info] of Object.entries(balance.total)) {
      if (info > 0) assets[coin] = { total: info, free: balance.free[coin] || 0, used: balance.used[coin] || 0 };
    }
    _balanceCache = assets;
    _balanceCacheTs = Date.now();
    return assets;
  } catch (e2) {
    console.log('[Binance] ccxt fetchBalance failed:', (e2.message || '').substring(0, 120));
  }

  // Return stale cache if available
  if (_balanceCache) return _balanceCache;
  throw new Error('No se pudo obtener balance de Binance');
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

// ── Detectar nuevos listings de Binance ──────────────────────────────────────
// Compara lista actual de pares /USDT vs lista guardada. Si aparece uno nuevo → listing reciente
let _knownPairs = new Set();
let _knownPairsLoaded = false;

async function checkNewListings() {
  try {
    const exchange = _getSharedExchange();
    await exchange.loadMarkets(true); // forzar refresh
    const currentPairs = Object.keys(exchange.markets)
      .filter(s => s.endsWith('/USDT') && !s.includes(':') && exchange.markets[s].active);

    if (!_knownPairsLoaded) {
      // Primera carga: guardar todos los pares actuales como "conocidos"
      _knownPairs = new Set(currentPairs);
      _knownPairsLoaded = true;
      console.log(`[Binance] Listings: ${_knownPairs.size} pares /USDT conocidos`);
      return [];
    }

    // Detectar nuevos (están en current pero no en known)
    const newListings = currentPairs.filter(p => !_knownPairs.has(p));

    // Actualizar la lista
    for (const p of currentPairs) _knownPairs.add(p);

    if (newListings.length > 0) {
      console.log(`[Binance] 🚀 NUEVO LISTING DETECTADO: ${newListings.join(', ')}`);

      // Obtener datos del nuevo par
      const results = [];
      for (const symbol of newListings) {
        try {
          const ticker = await exchange.fetchTicker(symbol);
          if (ticker && ticker.last > 0) {
            results.push({
              symbol,
              price: ticker.last,
              change24h: ticker.percentage || 0,
              volume: ticker.quoteVolume || 0,
              isNewListing: true,
            });
          }
        } catch {}
      }
      return results;
    }

    return [];
  } catch (e) {
    console.warn('[Binance] checkNewListings error:', (e.message || '').substring(0, 60));
    return [];
  }
}

module.exports = { getBalances, getTicker, getOHLCV, createOrder, testConnection, getExchangeForUser, getTopPairs, getTopGainers, checkNewListings, getFirstBinanceBalance, resaveApiKey, SUPPORTED_EXCHANGES };