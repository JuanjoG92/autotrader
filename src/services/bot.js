const cron = require('node-cron');
const https = require('https');
const { getDB } = require('../models/db');
const { getOHLCV, createOrder } = require('./binance');

const activeCrons = {};
let broadcastFn = () => {};

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

// -- Strategies --

function smaStrategy(candles, config) {
  const shortPeriod = config.shortPeriod || 10;
  const longPeriod = config.longPeriod || 30;
  if (candles.length < longPeriod) return 'hold';
  const closes = candles.map(c => c[4]);
  const shortSMA = avg(closes.slice(-shortPeriod));
  const longSMA = avg(closes.slice(-longPeriod));
  const prevShort = avg(closes.slice(-(shortPeriod + 1), -1));
  const prevLong = avg(closes.slice(-(longPeriod + 1), -1));
  if (prevShort <= prevLong && shortSMA > longSMA) return 'buy';
  if (prevShort >= prevLong && shortSMA < longSMA) return 'sell';
  return 'hold';
}

function rsiStrategy(candles, config) {
  const period = config.rsiPeriod || 14;
  const overbought = config.overbought || 70;
  const oversold = config.oversold || 30;
  if (candles.length < period + 1) return 'hold';
  const closes = candles.map(c => c[4]);
  const rsi = calcRSI(closes, period);
  if (rsi <= oversold) return 'buy';
  if (rsi >= overbought) return 'sell';
  return 'hold';
}

function macdStrategy(candles, config) {
  const fastLen = config.fastPeriod || 12;
  const slowLen = config.slowPeriod || 26;
  const signalLen = config.signalPeriod || 9;
  if (candles.length < slowLen + signalLen) return 'hold';
  const closes = candles.map(c => c[4]);
  const macdLine = ema(closes, fastLen).map((v, i) => v - ema(closes, slowLen)[i]);
  const signalLine = ema(macdLine.slice(-signalLen * 2), signalLen);
  const curr = macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1];
  const prev = macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2];
  if (prev <= 0 && curr > 0) return 'buy';
  if (prev >= 0 && curr < 0) return 'sell';
  return 'hold';
}

const STRATEGIES = { sma_crossover: smaStrategy, rsi: rsiStrategy, macd: macdStrategy };

// -- Math helpers --

function avg(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

function ema(data, period) {
  const k = 2 / (period + 1);
  const result = [data[0]];
  for (let i = 1; i < data.length; i++) result.push(data[i] * k + result[i - 1] * (1 - k));
  return result;
}

function calcRSI(closes, period) {
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// -- Bot execution --

async function executeBot(bot) {
  const db = getDB();
  try {
    const config = JSON.parse(bot.config || '{}');
    const strategyFn = STRATEGIES[bot.strategy];
    if (!strategyFn) return;

    const timeframe = config.timeframe || '1h';
    const candles = await getOHLCV(bot.pair, timeframe, 100);
    const signal = strategyFn(candles, config);

    db.prepare('UPDATE bots SET last_signal = ?, last_run = CURRENT_TIMESTAMP WHERE id = ?').run(signal, bot.id);

    if (signal === 'hold') {
      broadcastFn({ type: 'bot_signal', botId: bot.id, signal, pair: bot.pair });
      return;
    }

    const tradeAmount = config.tradeAmount || 0.001;
    const order = await createOrder(bot.user_id, bot.api_key_id, bot.pair, signal, tradeAmount);

    const price = order.average || order.price || 0;
    const total = price * tradeAmount;
    const fee = order.fee ? order.fee.cost || 0 : 0;

    const keyRow = db.prepare('SELECT exchange FROM api_keys WHERE id = ?').get(bot.api_key_id);
    const exchangeName = keyRow ? keyRow.exchange : 'bybit';

    db.prepare(`INSERT INTO trades (user_id, bot_id, exchange, pair, side, amount, price, total, fee, order_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      bot.user_id, bot.id, exchangeName, bot.pair, signal, tradeAmount, price, total, fee, order.id || ''
    );

    broadcastFn({ type: 'trade', botId: bot.id, signal, pair: bot.pair, price, amount: tradeAmount });
  } catch (err) {
    console.error('Bot ' + bot.id + ' error:', err.message);
    broadcastFn({ type: 'bot_error', botId: bot.id, error: err.message });
  }
}

function startBot(botId) {
  const db = getDB();
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(botId);
  if (!bot) return;

  if (activeCrons[botId]) { activeCrons[botId].stop(); delete activeCrons[botId]; }

  const config = JSON.parse(bot.config || '{}');
  const interval = config.interval || '*/5 * * * *';

  const task = cron.schedule(interval, () => executeBot(bot));
  activeCrons[botId] = task;
  db.prepare("UPDATE bots SET status = 'active' WHERE id = ?").run(botId);
  console.log('Bot ' + botId + ' started: ' + bot.pair + ' ' + bot.strategy + ' every ' + interval);
}

function stopBot(botId) {
  const db = getDB();
  if (activeCrons[botId]) { activeCrons[botId].stop(); delete activeCrons[botId]; }
  db.prepare("UPDATE bots SET status = 'paused' WHERE id = ?").run(botId);
  console.log('Bot ' + botId + ' stopped');
}

function startAllActiveBots(broadcast) {
  broadcastFn = broadcast;
  const db = getDB();
  const bots = db.prepare("SELECT * FROM bots WHERE status = 'active'").all();
  bots.forEach(b => startBot(b.id));
  console.log('Resumed ' + bots.length + ' active bots');
}

// -- Price stream via Binance (30s interval) --

const PRICE_PAIRS = ['BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'SOL/USDT', 'XRP/USDT'];

function priceStream(broadcast) {
  const { getTicker } = require('./binance');

  async function fetchPrices() {
    try {
      const data = [];
      for (const symbol of PRICE_PAIRS) {
        try {
          const t = await getTicker(symbol);
          if (t && t.last > 0) data.push({ symbol, price: t.last, change: t.percentage || 0 });
        } catch {}
      }
      if (data.length > 0) broadcast({ type: 'prices', data });
    } catch (err) {
      console.error('Price stream error:', err.message);
    }
  }

  fetchPrices();
  setInterval(fetchPrices, 30000);
}

module.exports = { startBot, stopBot, startAllActiveBots, priceStream, STRATEGIES };
