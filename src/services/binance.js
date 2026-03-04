const ccxt = require('ccxt');
const https = require('https');
const { decrypt } = require('./encryption');
const { getDB } = require('../models/db');

// ── HTTP helper ──

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept': 'application/json', 'Accept-Encoding': 'identity' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ── CoinCap asset ID mapping ──

const COINCAP_IDS = {
  'BTC': 'bitcoin', 'ETH': 'ethereum', 'BNB': 'binance-coin',
  'SOL': 'solana', 'XRP': 'xrp', 'ADA': 'cardano',
  'DOGE': 'dogecoin', 'MATIC': 'polygon', 'DOT': 'polkadot',
  'AVAX': 'avalanche', 'LINK': 'chainlink', 'UNI': 'uniswap',
  'SHIB': 'shiba-inu', 'LTC': 'litecoin', 'TRX': 'tron',
  'ATOM': 'cosmos', 'FIL': 'filecoin', 'APT': 'aptos',
  'NEAR': 'near-protocol', 'ARB': 'arbitrum',
};

function getCoinCapId(symbol) {
  const base = symbol.split('/')[0];
  return COINCAP_IDS[base] || base.toLowerCase();
}

// ── Exchange (ccxt) ──

const SUPPORTED_EXCHANGES = ['bybit', 'binance', 'kucoin', 'okx', 'bitget'];

function createExchange(apiKeyRow) {
  const apiKey = decrypt(apiKeyRow.api_key_enc);
  const secret = decrypt(apiKeyRow.api_secret_enc);
  const exchangeName = apiKeyRow.exchange || 'bybit';
  const ExchangeClass = ccxt[exchangeName];
  if (!ExchangeClass) throw new Error('Exchange no soportado: ' + exchangeName);
  return new ExchangeClass({
    apiKey,
    secret,
    enableRateLimit: true,
    options: { defaultType: 'spot' },
  });
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

// ── Market data via CoinCap (free, no rate limit) ──

async function getTicker(pair) {
  const id = getCoinCapId(pair);
  const url = 'https://api.coincap.io/v2/assets/' + id;
  const json = await fetchJSON(url);
  const d = json.data || {};
  return {
    symbol: pair,
    last: parseFloat(d.priceUsd) || 0,
    percentage: parseFloat(d.changePercent24Hr) || 0,
    quoteVolume: parseFloat(d.volumeUsd24Hr) || 0,
  };
}

async function getOHLCV(pair, timeframe, limit) {
  const id = getCoinCapId(pair);
  const intervalMap = { '1m': 'm1', '5m': 'm5', '15m': 'm15', '30m': 'm30', '1h': 'h1', '2h': 'h2', '4h': 'h6', '1d': 'd1' };
  const interval = intervalMap[timeframe] || 'h1';
  const msMap = { 'm1': 60000, 'm5': 300000, 'm15': 900000, 'm30': 1800000, 'h1': 3600000, 'h2': 7200000, 'h6': 21600000, 'd1': 86400000 };
  const span = (msMap[interval] || 3600000) * limit;
  const end = Date.now();
  const start = end - span;
  const url = 'https://api.coincap.io/v2/assets/' + id + '/history?interval=' + interval + '&start=' + start + '&end=' + end;
  const json = await fetchJSON(url);
  if (!json.data || !json.data.length) return [];
  return json.data.map(p => [p.time, parseFloat(p.priceUsd), parseFloat(p.priceUsd), parseFloat(p.priceUsd), parseFloat(p.priceUsd), 0]);
}

async function createOrder(userId, apiKeyId, pair, side, amount) {
  const exchange = getExchangeForUser(userId, apiKeyId);
  return exchange.createMarketOrder(pair, side, amount);
}

async function testConnection(userId, apiKeyId) {
  const exchange = getExchangeForUser(userId, apiKeyId);
  const balance = await exchange.fetchBalance();
  return { success: true, totalAssets: Object.keys(balance.total).filter(k => balance.total[k] > 0).length };
}

async function getTopPairs() {
  const url = 'https://api.coincap.io/v2/assets?limit=20';
  const json = await fetchJSON(url);
  if (!json.data) return [];
  return json.data.map(c => ({
    symbol: (c.symbol || '').toUpperCase() + '/USDT',
    price: parseFloat(c.priceUsd) || 0,
    change24h: parseFloat(c.changePercent24Hr) || 0,
    volume: parseFloat(c.volumeUsd24Hr) || 0,
    high: parseFloat(c.priceUsd) || 0,
    low: parseFloat(c.priceUsd) || 0,
  }));
}

module.exports = { getBalances, getTicker, getOHLCV, createOrder, testConnection, getExchangeForUser, getTopPairs, SUPPORTED_EXCHANGES };