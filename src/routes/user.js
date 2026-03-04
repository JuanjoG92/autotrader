const express = require('express');
const auth = require('../middleware/auth');
const { getDB } = require('../models/db');
const { encrypt } = require('../services/encryption');
const { testConnection, getBalances } = require('../services/binance');
const router = express.Router();

// ── API Keys ──

router.get('/keys', auth, (req, res) => {
  const db = getDB();
  const keys = db.prepare('SELECT id, exchange, label, permissions, created_at FROM api_keys WHERE user_id = ?').all(req.userId);
  res.json(keys);
});

router.post('/keys', auth, (req, res) => {
  try {
    const { apiKey, apiSecret, exchange = 'bybit', label = '', permissions = 'spot' } = req.body;
    if (!apiKey || !apiSecret) return res.status(400).json({ error: 'API Key y Secret requeridos' });

    if (exchange === 'binance' && !process.env.BINANCE_PROXY) {
      return res.status(400).json({ error: 'Binance requiere configuración de proxy en el servidor. Contactá al administrador o usá Bybit/KuCoin.' });
    }

    const db = getDB();
    const enc_key = encrypt(apiKey);
    const enc_secret = encrypt(apiSecret);
    const result = db.prepare('INSERT INTO api_keys (user_id, exchange, label, api_key_enc, api_secret_enc, permissions) VALUES (?,?,?,?,?,?)')
      .run(req.userId, exchange, label, enc_key, enc_secret, permissions);

    res.json({ id: result.lastInsertRowid, exchange, label, permissions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/keys/:id', auth, (req, res) => {
  const db = getDB();
  const result = db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'Key no encontrada' });
  res.json({ success: true });
});

router.post('/keys/:id/test', auth, async (req, res) => {
  try {
    const result = await testConnection(req.userId, parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('restricted location') || msg.includes('Service unavailable')) {
      return res.status(400).json({ error: 'Binance bloquea conexiones desde este servidor. Usá Bybit o KuCoin en su lugar (no tienen restricciones geográficas).' });
    }
    res.status(400).json({ error: 'Conexión fallida: ' + msg });
  }
});

router.get('/keys/:id/balances', auth, async (req, res) => {
  try {
    const balances = await getBalances(req.userId, parseInt(req.params.id));
    res.json(balances);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
