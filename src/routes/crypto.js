// src/routes/crypto.js
// API routes para el Crypto AI Trader (Binance)

const express = require('express');
const router  = express.Router();
const crypto  = require('../services/crypto-trader');
const binance = require('../services/binance');
const { getDB } = require('../models/db');

// Estado general
router.get('/status', (req, res) => {
  res.json(crypto.getStatus());
});

// Config
router.get('/config', (req, res) => {
  res.json(crypto.getConfig());
});

router.put('/config', (req, res) => {
  try {
    const cfg = crypto.updateConfig(req.body);
    res.json({ ok: true, config: cfg });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Encender / apagar
router.post('/enable', (req, res) => {
  const cfg = crypto.updateConfig({ enabled: 1 });
  res.json({ ok: true, message: 'Crypto Trader activado', config: cfg });
});

router.post('/disable', (req, res) => {
  const cfg = crypto.updateConfig({ enabled: 0 });
  res.json({ ok: true, message: 'Crypto Trader desactivado', config: cfg });
});

// Forzar análisis
router.post('/analyze', async (req, res) => {
  try {
    const result = await crypto.runAnalysis();
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Posiciones
router.get('/positions', (req, res) => {
  res.json(crypto.getOpenPositions());
});

router.get('/history', (req, res) => {
  res.json(crypto.getPositionHistory(req.query.limit || 30));
});

// Resumen crypto (posiciones + PnL + volumen real)
router.get('/summary', (req, res) => {
  const db = getDB();
  const open = db.prepare("SELECT COUNT(*) as count FROM crypto_positions WHERE status = 'OPEN'").get();
  const closed = db.prepare("SELECT COUNT(*) as count, SUM(pnl) as total_pnl FROM crypto_positions WHERE status = 'CLOSED'").get();
  const total = db.prepare("SELECT COUNT(*) as count FROM crypto_positions").get();
  // Only LIVE trades (not paper)
  const live = db.prepare("SELECT COUNT(*) as count, SUM(entry_price * quantity) as volume FROM crypto_positions WHERE order_id NOT LIKE 'PAPER%'").get();
  res.json({
    open_positions: open?.count || 0,
    closed_positions: closed?.count || 0,
    total_positions: total?.count || 0,
    total_pnl: closed?.total_pnl || 0,
    live_trades: live?.count || 0,
    live_volume: live?.volume || 0,
  });
});

// Balance Binance (primera key disponible)
router.get('/balance', async (req, res) => {
  try {
    const bal = await binance.getFirstBinanceBalance();
    res.json(bal || {});
  } catch (e) {
    console.log('[Crypto] Balance error:', (e.message || '').substring(0, 100));
    res.json({ error: e.message || 'Error obteniendo balance' });
  }
});

// Market tickers via Binance
router.get('/market', async (req, res) => {
  try {
    const pairs = await binance.getTopPairs();
    res.json(pairs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Orden manual crypto
router.post('/order', async (req, res) => {
  try {
    const { symbol, side, amountUSD } = req.body;
    if (!symbol || !side || !amountUSD) return res.status(400).json({ error: 'symbol, side, amountUSD requeridos' });

    const db = getDB();
    const key = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
    if (!key) return res.status(400).json({ error: 'No hay API key de Binance configurada' });

    const ticker = await binance.getTicker(symbol);
    const price = ticker?.last || 0;
    if (price <= 0) return res.status(400).json({ error: 'Sin precio para ' + symbol });

    const quantity = parseFloat((amountUSD / price).toFixed(6));
    if (quantity <= 0) return res.status(400).json({ error: 'Monto muy pequeño' });

    const order = await binance.createOrder(key.user_id, key.id, symbol, side.toLowerCase(), quantity);
    res.json({ ok: true, order, price, quantity, total: amountUSD });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Actualizar API Key de Binance
router.post('/update-key', async (req, res) => {
  try {
    const { apiKey, apiSecret } = req.body;
    if (!apiKey || !apiSecret) return res.status(400).json({ error: 'apiKey y apiSecret requeridos' });
    const result = binance.resaveApiKey(apiKey.trim(), apiSecret.trim());
    // Test connection with new key
    try {
      const bal = await binance.getFirstBinanceBalance();
      const usdt = bal?.USDT?.free || 0;
      res.json({ ok: true, ...result, balance_usdt: usdt, message: 'API Key actualizada y verificada' });
    } catch (e) {
      res.json({ ok: true, ...result, warning: 'Key guardada pero falló la verificación: ' + e.message });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Limpiar posiciones paper y resetear
router.post('/reset', (req, res) => {
  const db = getDB();
  const r = db.prepare("UPDATE crypto_positions SET status = 'CLOSED', reason = 'manual reset' WHERE status = 'OPEN'").run();
  res.json({ ok: true, closed: r.changes });
});

module.exports = router;
