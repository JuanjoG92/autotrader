const express = require('express');
const auth = require('../middleware/auth');
const { getDB } = require('../models/db');
const { startBot, stopBot, STRATEGIES } = require('../services/bot');
const { getOHLCV, getTicker, getTopPairs } = require('../services/binance');
const router = express.Router();

// ── Market data (public) ──

router.get('/ticker/:pair', async (req, res) => {
  try {
    const pair = req.params.pair.replace('-', '/');
    const ticker = await getTicker(pair);
    res.json(ticker);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/ohlcv/:pair', async (req, res) => {
  try {
    const pair = req.params.pair.replace('-', '/');
    const tf = req.query.timeframe || '1h';
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const data = await getOHLCV(pair, tf, limit);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/top-pairs', async (req, res) => {
  try {
    const pairs = await getTopPairs('binance', 20);
    res.json(pairs);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/strategies', (req, res) => {
  res.json([
    { id: 'sma_crossover', name: 'SMA Crossover', desc: 'Cruza media móvil corta vs larga', params: ['shortPeriod', 'longPeriod', 'tradeAmount', 'interval', 'timeframe'] },
    { id: 'rsi', name: 'RSI', desc: 'Compra en sobreventa, vende en sobrecompra', params: ['rsiPeriod', 'overbought', 'oversold', 'tradeAmount', 'interval', 'timeframe'] },
    { id: 'macd', name: 'MACD', desc: 'Señales de cruce MACD/Signal', params: ['fastPeriod', 'slowPeriod', 'signalPeriod', 'tradeAmount', 'interval', 'timeframe'] },
  ]);
});

// ── Bots CRUD ──

router.get('/bots', auth, (req, res) => {
  const db = getDB();
  const bots = db.prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY created_at DESC').all(req.userId);
  res.json(bots.map(b => ({ ...b, config: JSON.parse(b.config || '{}') })));
});

router.post('/bots', auth, (req, res) => {
  try {
    const { name, pair, strategy, config, apiKeyId } = req.body;
    if (!name || !pair || !strategy || !apiKeyId) return res.status(400).json({ error: 'Campos requeridos: name, pair, strategy, apiKeyId' });
    if (!STRATEGIES[strategy]) return res.status(400).json({ error: 'Estrategia no válida' });

    const db = getDB();
    const key = db.prepare('SELECT id FROM api_keys WHERE id = ? AND user_id = ?').get(apiKeyId, req.userId);
    if (!key) return res.status(400).json({ error: 'API Key no encontrada' });

    const configStr = JSON.stringify(config || {});
    const result = db.prepare('INSERT INTO bots (user_id, api_key_id, name, pair, strategy, config) VALUES (?,?,?,?,?,?)')
      .run(req.userId, apiKeyId, name, pair, strategy, configStr);

    res.json({ id: result.lastInsertRowid, name, pair, strategy, config: config || {}, status: 'paused' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bots/:id/start', auth, (req, res) => {
  const db = getDB();
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
  startBot(bot.id);
  res.json({ success: true, status: 'active' });
});

router.post('/bots/:id/stop', auth, (req, res) => {
  const db = getDB();
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
  stopBot(bot.id);
  res.json({ success: true, status: 'paused' });
});

router.delete('/bots/:id', auth, (req, res) => {
  const db = getDB();
  stopBot(parseInt(req.params.id));
  const result = db.prepare('DELETE FROM bots WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'Bot no encontrado' });
  res.json({ success: true });
});

// ── Trade history ──

router.get('/trades', auth, (req, res) => {
  const db = getDB();
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const trades = db.prepare('SELECT * FROM trades WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(req.userId, limit);
  res.json(trades);
});

router.get('/trades/summary', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare(`
    SELECT COUNT(*) as total, 
           SUM(CASE WHEN side='buy' THEN 1 ELSE 0 END) as buys,
           SUM(CASE WHEN side='sell' THEN 1 ELSE 0 END) as sells,
           SUM(total) as volume,
           SUM(pnl) as total_pnl
    FROM trades WHERE user_id = ?
  `).get(req.userId);
  res.json(row);
});

module.exports = router;
