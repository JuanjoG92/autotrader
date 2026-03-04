const ccxt = require('ccxt');
const { decrypt } = require('./encryption');
const { getDB } = require('../models/db');

function createExchange(apiKeyRow) {
  const apiKey = decrypt(apiKeyRow.api_key_enc);
  const secret = decrypt(apiKeyRow.api_secret_enc);
  const ExchangeClass = ccxt[apiKeyRow.exchange] || ccxt.binance;
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

async function getTicker(pair, exchangeName = 'binance') {
  const exchange = new ccxt[exchangeName]({ enableRateLimit: true });
  return exchange.fetchTicker(pair);
}

async function getOHLCV(pair, timeframe = '1h', limit = 100, exchangeName = 'binance') {
  const exchange = new ccxt[exchangeName]({ enableRateLimit: true });
  return exchange.fetchOHLCV(pair, timeframe, undefined, limit);
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

async function getTopPairs(exchangeName = 'binance', limit = 20) {
  const exchange = new ccxt[exchangeName]({ enableRateLimit: true });
  const tickers = await exchange.fetchTickers();
  const usdtPairs = Object.values(tickers)
    .filter(t => t.symbol.endsWith('/USDT') && t.quoteVolume)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, limit);
  return usdtPairs.map(t => ({
    symbol: t.symbol,
    price: t.last,
    change24h: t.percentage,
    volume: t.quoteVolume,
    high: t.high,
    low: t.low,
  }));
}

module.exports = { getBalances, getTicker, getOHLCV, createOrder, testConnection, getExchangeForUser, getTopPairs };
