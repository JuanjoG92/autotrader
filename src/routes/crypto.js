// src/routes/crypto.js
// API routes para el Crypto AI Trader (Binance)

const express = require('express');
const router  = express.Router();
const crypto  = require('../services/crypto-trader');

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

// Limpiar posiciones paper y resetear
router.post('/reset', (req, res) => {
  const { getDB } = require('../models/db');
  const db = getDB();
  const r = db.prepare("UPDATE crypto_positions SET status = 'CLOSED', reason = 'manual reset' WHERE status = 'OPEN'").run();
  res.json({ ok: true, closed: r.changes });
});

module.exports = router;
