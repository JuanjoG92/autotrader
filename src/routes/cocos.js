// src/routes/cocos.js
// Endpoints Cocos Capital — autenticados + owner-only para órdenes

const express  = require('express');
const router   = express.Router();
const auth     = require('../middleware/auth');
const cocos    = require('../services/cocos');

const OWNER_ID = parseInt(process.env.COCOS_OWNER_USER_ID || '1');

// Helper: mapear errores de Cocos API para no confundir al frontend
// 401 de Cocos = "sesión Cocos inválida" → devolver 502 (no 401, que el front interpreta como JWT expirado)
function cocosErrorStatus(e) {
  if (e.status === 401) return 502; // Cocos auth error → 502 para el frontend
  return e.status || 500;
}

// Middleware: solo el dueño puede ejecutar órdenes
function ownerOnly(req, res, next) {
  if (req.userId !== OWNER_ID) {
    return res.status(403).json({ error: 'Acceso denegado: solo el propietario puede operar' });
  }
  next();
}

// Middleware: verificar que el servicio esté activo
function requireReady(req, res, next) {
  if (!cocos.isReady()) {
    return res.status(503).json({ error: 'Servicio Cocos no disponible. Actualiza los tokens.' });
  }
  next();
}

// ── Estado y admin ────────────────────────────────────────────────────────────

// GET /api/cocos/status
router.get('/status', auth, (req, res) => {
  res.json(cocos.getSessionInfo());
});

// POST /api/cocos/admin/refresh   — forzar renovación de token (owner)
router.post('/admin/refresh', auth, ownerOnly, async (req, res) => {
  try {
    await cocos.forceRefresh();
    res.json({ ok: true, session: cocos.getSessionInfo() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/cocos/admin/tokens   — actualizar tokens manualmente (owner)
// Body: { access_token, refresh_token, account_id }
router.post('/admin/tokens', auth, ownerOnly, async (req, res) => {
  const { access_token, refresh_token, account_id } = req.body;
  if (!access_token || !refresh_token) {
    return res.status(400).json({ error: 'access_token y refresh_token son requeridos' });
  }
  try {
    await cocos.updateTokens(access_token, refresh_token, account_id);
    res.json({ ok: true, session: cocos.getSessionInfo() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Mercado (cualquier usuario autenticado) ───────────────────────────────────

// GET /api/cocos/market
router.get('/market', auth, requireReady, async (req, res) => {
  try { res.json(await cocos.getMarketStatus()); }
  catch (e) { res.status(cocosErrorStatus(e)).json({ error: e.message }); }
});

// GET /api/cocos/dolar-mep
router.get('/dolar-mep', auth, requireReady, async (req, res) => {
  try { res.json(await cocos.getDolarMEP()); }
  catch (e) { res.status(cocosErrorStatus(e)).json({ error: e.message }); }
});

// GET /api/cocos/search?q=GGAL
router.get('/search', auth, requireReady, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Parámetro q requerido' });
  try { res.json(await cocos.searchTicker(q)); }
  catch (e) { res.status(cocosErrorStatus(e)).json({ error: e.message }); }
});

// GET /api/cocos/quote/:ticker?segment=C
router.get('/quote/:ticker', auth, requireReady, async (req, res) => {
  try { res.json(await cocos.getQuote(req.params.ticker, req.query.segment)); }
  catch (e) { res.status(cocosErrorStatus(e)).json({ error: e.message }); }
});

// GET /api/cocos/list?type=ACCIONES&subtype=LIDERES&settlement=24hs&currency=ARS
router.get('/list', auth, requireReady, async (req, res) => {
  const { type, subtype, settlement, currency, segment, page, size } = req.query;
  if (!type || !subtype) return res.status(400).json({ error: 'type y subtype requeridos' });
  try {
    res.json(await cocos.getMarketList(type, subtype, settlement || '24hs', currency || 'ARS', segment || 'C', page, size));
  } catch (e) { res.status(cocosErrorStatus(e)).json({ error: e.message }); }
});

// ── Cuenta (solo owner) ───────────────────────────────────────────────────────

// GET /api/cocos/portfolio
router.get('/portfolio', auth, ownerOnly, requireReady, async (req, res) => {
  try {
    const data = await cocos.getPortfolio();
    res.json(data);
  } catch (e) {
    // Cocos devuelve 404 cuando el portfolio está vacío
    if (e.status === 404 || e.message?.includes('404') || e.message?.includes('Not Found')) {
      return res.json({ positions: [], total_value: 0, empty: true });
    }
    res.status(cocosErrorStatus(e)).json({ error: e.message });
  }
});

// GET /api/cocos/buying-power
router.get('/buying-power', auth, ownerOnly, requireReady, async (req, res) => {
  try { res.json(await cocos.getBuyingPower()); }
  catch (e) { res.status(cocosErrorStatus(e)).json({ error: e.message }); }
});

// GET /api/cocos/performance?type=daily
router.get('/performance', auth, ownerOnly, requireReady, async (req, res) => {
  try { res.json(await cocos.getPerformance(req.query.type)); }
  catch (e) { res.status(cocosErrorStatus(e)).json({ error: e.message }); }
});

// GET /api/cocos/orders
router.get('/orders', auth, ownerOnly, requireReady, async (req, res) => {
  try { res.json(await cocos.getOrders()); }
  catch (e) { res.status(cocosErrorStatus(e)).json({ error: e.message }); }
});

// GET /api/cocos/orders/:id
router.get('/orders/:id', auth, ownerOnly, requireReady, async (req, res) => {
  try { res.json(await cocos.getOrderStatus(req.params.id)); }
  catch (e) { res.status(cocosErrorStatus(e)).json({ error: e.message }); }
});

// GET /api/cocos/selling-power?long_ticker=GGAL-0002-C-CT-ARS
router.get('/selling-power', auth, ownerOnly, requireReady, async (req, res) => {
  const { long_ticker } = req.query;
  if (!long_ticker) return res.status(400).json({ error: 'long_ticker requerido' });
  try { res.json(await cocos.getSellingPower(long_ticker)); }
  catch (e) { res.status(cocosErrorStatus(e)).json({ error: e.message }); }
});

// ── Órdenes (OWNER ONLY — operaciones reales con dinero real) ─────────────────

// POST /api/cocos/orders/buy
// Body: { ticker, quantity, price, settlement, currency, segment }
router.post('/orders/buy', auth, ownerOnly, requireReady, async (req, res) => {
  const { ticker, quantity, price, settlement, currency, segment } = req.body;
  if (!ticker || !quantity || !price) {
    return res.status(400).json({ error: 'ticker, quantity y price son requeridos' });
  }
  if (isNaN(quantity) || isNaN(price) || parseFloat(quantity) <= 0 || parseFloat(price) <= 0) {
    return res.status(400).json({ error: 'quantity y price deben ser números positivos' });
  }
  try {
    const result = await cocos.placeBuyOrder(ticker, quantity, price, settlement, currency, segment);
    res.json(result);
  } catch (e) { res.status(cocosErrorStatus(e)).json({ error: e.message }); }
});

// POST /api/cocos/orders/sell
// Body: { ticker, quantity, price, settlement, currency, segment }
router.post('/orders/sell', auth, ownerOnly, requireReady, async (req, res) => {
  const { ticker, quantity, price, settlement, currency, segment } = req.body;
  if (!ticker || !quantity || !price) {
    return res.status(400).json({ error: 'ticker, quantity y price son requeridos' });
  }
  if (isNaN(quantity) || isNaN(price) || parseFloat(quantity) <= 0 || parseFloat(price) <= 0) {
    return res.status(400).json({ error: 'quantity y price deben ser números positivos' });
  }
  try {
    const result = await cocos.placeSellOrder(ticker, quantity, price, settlement, currency, segment);
    res.json(result);
  } catch (e) { res.status(cocosErrorStatus(e)).json({ error: e.message }); }
});

// POST /api/cocos/orders/raw   — orden con long_ticker ya armado
// Body: { long_ticker, side, quantity, price }
router.post('/orders/raw', auth, ownerOnly, requireReady, async (req, res) => {
  const { long_ticker, side, quantity, price } = req.body;
  if (!long_ticker || !side || !quantity || !price) {
    return res.status(400).json({ error: 'long_ticker, side, quantity y price son requeridos' });
  }
  if (!['BUY', 'SELL'].includes(side.toUpperCase())) {
    return res.status(400).json({ error: 'side debe ser BUY o SELL' });
  }
  try {
    const result = await cocos.placeOrderByLongTicker(long_ticker, side, quantity, price);
    res.json(result);
  } catch (e) { res.status(cocosErrorStatus(e)).json({ error: e.message }); }
});

// DELETE /api/cocos/orders/:id   — cancelar orden
router.delete('/orders/:id', auth, ownerOnly, requireReady, async (req, res) => {
  try {
    const result = await cocos.cancelOrder(req.params.id);
    res.json(result);
  } catch (e) { res.status(cocosErrorStatus(e)).json({ error: e.message }); }
});

module.exports = router;
