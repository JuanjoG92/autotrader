// src/routes/cocos.js
// Endpoints Cocos Capital — autenticados + owner-only para órdenes

const express  = require('express');
const router   = express.Router();
const auth     = require('../middleware/auth');
const cocos    = require('../services/cocos');

const OWNER_ID = parseInt(process.env.COCOS_OWNER_USER_ID || '1');

// Helper: mapear errores de Cocos API para no confundir al frontend
// 401/403 de Cocos = error de sesión Cocos → devolver 502 (no 401/403, que el front interpreta como JWT/permisos)
function cocosErrorStatus(e) {
  if (e.status === 401 || e.status === 403) return 502;
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

// TEMP DEBUG - remove later
router.get('/debug-portfolio', async (req, res) => {
  try {
    if (!cocos.isReady()) return res.json({ error: 'Cocos not ready' });
    const data = await cocos.getPortfolio();
    res.json({ raw_type: typeof data, is_array: Array.isArray(data), keys: Object.keys(data || {}), data });
  } catch (e) {
    res.json({ error: e.message, status: e.status });
  }
});

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
    console.log('[DEBUG Portfolio] Raw keys:', Object.keys(data || {}), '| isArray:', Array.isArray(data), '| length:', Array.isArray(data) ? data.length : (data?.positions?.length ?? 'N/A'));
    if (Array.isArray(data) && data.length > 0) console.log('[DEBUG Portfolio] First item keys:', Object.keys(data[0]));
    res.json(data);
  } catch (e) {
    console.log('[DEBUG Portfolio] ERROR:', e.status, e.message);
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

// POST /api/cocos/sell-all — EMERGENCIA: vender todas las posiciones activas
router.post('/sell-all', async (req, res) => {
  // Sin auth — endpoint de emergencia para venta total
  try {
    if (!cocos.isReady()) return res.status(503).json({ error: 'Cocos no conectado' });

    // 1. Obtener portfolio real de Cocos
    let portfolio;
    try {
      portfolio = await cocos.getPortfolio();
    } catch (e) {
      return res.status(500).json({ error: 'No se pudo obtener portfolio: ' + e.message });
    }

    // Normalizar: portfolio puede ser array o { positions: [...] }
    let positions = [];
    if (Array.isArray(portfolio)) {
      positions = portfolio;
    } else if (portfolio?.positions && Array.isArray(portfolio.positions)) {
      positions = portfolio.positions;
    } else if (portfolio && typeof portfolio === 'object') {
      // Intentar extraer posiciones de cualquier estructura
      const keys = Object.keys(portfolio);
      for (const k of keys) {
        if (Array.isArray(portfolio[k])) { positions = portfolio[k]; break; }
      }
    }

    if (!positions.length) {
      return res.json({ ok: true, message: 'No hay posiciones para vender', positions: [] });
    }

    const results = [];
    for (const pos of positions) {
      const ticker = pos.ticker || pos.symbol || pos.instrument || '';
      const qty    = pos.quantity || pos.shares || pos.amount || pos.size || 0;
      const lt     = pos.long_ticker || '';
      const price  = pos.last_price || pos.price || pos.current_price || pos.close_price || 0;

      if (!ticker || qty <= 0 || price <= 0) {
        results.push({ ticker, status: 'SKIP', reason: 'Sin datos suficientes', qty, price });
        continue;
      }

      try {
        // Obtener selling power para confirmar que podemos vender
        let canSell = qty;
        if (lt) {
          try {
            const sp = await cocos.getSellingPower(lt);
            canSell = sp?.quantity || sp?.available || qty;
          } catch {}
        }

        const sellQty   = Math.min(qty, canSell);
        // Precio de venta: bid o last_price con descuento 0.5% para asegurar ejecución
        const bidPrice  = pos.bid || pos.bid_price || price;
        const sellPrice = Math.round(bidPrice * 0.995 * 100) / 100;

        let order;
        if (lt) {
          order = await cocos.placeOrderByLongTicker(lt, 'SELL', sellQty, sellPrice);
        } else {
          order = await cocos.placeSellOrder(ticker, sellQty, sellPrice, '24hs', 'ARS', 'C');
        }

        const orderId = order?.Orden || order?.id || 'OK';
        results.push({ ticker, long_ticker: lt, qty: sellQty, price: sellPrice, order_id: orderId, status: 'SENT' });
        console.log(`[SELL-ALL] ✅ SELL ${ticker} x${sellQty} @ $${sellPrice} — #${orderId}`);

        await new Promise(r => setTimeout(r, 1500));
      } catch (e) {
        results.push({ ticker, status: 'ERROR', error: e.message });
        console.error(`[SELL-ALL] ❌ Error vendiendo ${ticker}:`, e.message);
      }
    }

    // Marcar posiciones en auto_investments como CLOSED
    try {
      const { getDB } = require('../models/db');
      getDB().prepare("UPDATE auto_investments SET status = 'CLOSED' WHERE action = 'BUY' AND status = 'EXECUTED'").run();
    } catch {}

    // Desactivar auto-invest en DB
    try {
      const { getDB } = require('../models/db');
      getDB().prepare("UPDATE auto_invest_config SET enabled = 0 WHERE id = 1").run();
    } catch {}

    res.json({ ok: true, sold: results.filter(r => r.status === 'SENT').length, total: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/cocos/orders/:id   — cancelar orden
router.delete('/orders/:id', auth, ownerOnly, requireReady, async (req, res) => {
  try {
    const result = await cocos.cancelOrder(req.params.id);
    res.json(result);
  } catch (e) { res.status(cocosErrorStatus(e)).json({ error: e.message }); }
});

module.exports = router;
