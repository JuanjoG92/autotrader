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

// TEMP DEBUG - test sell readiness for known positions
router.get('/debug-sell-test', async (req, res) => {
  try {
    if (!cocos.isReady()) return res.json({ error: 'Cocos not ready' });
    const results = {};

    // Get quotes for the 3 known positions (USD)
    for (const ticker of ['PBR', 'VIST', 'NVDA']) {
      try {
        const q = await cocos.getQuote(ticker, 'C', 'USD');
        results[ticker] = {
          long_ticker: q?.long_ticker,
          last_price: q?.last_price,
          bid: q?.bid,
          ask: q?.ask,
          close: q?.close_price,
          previous_close: q?.previous_close_price,
        };
        // Try selling power
        if (q?.long_ticker) {
          try {
            const sp = await cocos.getSellingPower(q.long_ticker);
            results[ticker].selling_power = sp;
          } catch (e2) { results[ticker].sp_error = e2.message; }
        }
      } catch (e) { results[ticker] = { error: e.message }; }
      await new Promise(r => setTimeout(r, 1000));
    }

    // Also try DB positions
    const { getDB } = require('../models/db');
    const dbPositions = getDB().prepare(
      "SELECT id, ticker, quantity, price, currency, status FROM auto_investments WHERE action='BUY' AND status='EXECUTED'"
    ).all();

    res.json({ quotes: results, db_positions: dbPositions, cocos_ready: cocos.isReady() });
  } catch (e) {
    res.json({ error: e.message });
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
    res.json(data);
  } catch (e) {
    // Cocos devuelve 404 — construir portfolio desde DB + quotes
    if (e.status === 404 || e.message?.includes('404') || e.message?.includes('Not Found')) {
      try {
        const { getDB } = require('../models/db');
        const dbPos = getDB().prepare(
          "SELECT * FROM auto_investments WHERE action='BUY' AND status='EXECUTED' ORDER BY created_at DESC"
        ).all();
        if (!dbPos.length) return res.json({ positions: [], total_value: 0, empty: true });

        const positions = [];
        let totalValue = 0;
        for (const p of dbPos) {
          let currentPrice = p.price;
          let longTicker = '';
          try {
            const q = await cocos.getQuote(p.ticker, 'C', p.currency || 'ARS');
            currentPrice = q?.last_price || q?.close_price || q?.previous_close_price || p.price;
            longTicker = q?.long_ticker || '';
          } catch {}
          const value = currentPrice * p.quantity;
          const pnl = (currentPrice - p.price) * p.quantity;
          const pnlPct = p.price > 0 ? ((currentPrice - p.price) / p.price * 100) : 0;
          totalValue += value;
          positions.push({
            ticker: p.ticker, long_ticker: longTicker, quantity: p.quantity,
            buy_price: p.price, last_price: currentPrice, value,
            pnl: parseFloat(pnl.toFixed(2)), pnl_pct: parseFloat(pnlPct.toFixed(2)),
            currency: p.currency || 'ARS', source: 'db',
            stop_loss_price: p.stop_loss_price, take_profit_price: p.take_profit_price,
            created_at: p.created_at,
          });
        }
        return res.json({ positions, total_value: parseFloat(totalValue.toFixed(2)), source: 'db_fallback' });
      } catch (e2) {
        return res.json({ positions: [], total_value: 0, empty: true, error: e2.message });
      }
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
// NO depende de getPortfolio() (que da 404). Usa posiciones DB + getQuote directo.
router.post('/sell-all', async (req, res) => {
  try {
    if (!cocos.isReady()) return res.status(503).json({ error: 'Cocos no conectado' });

    const { getDB } = require('../models/db');
    const db = getDB();

    // 1. Obtener posiciones EJECUTADAS de la DB (fuente confiable)
    const dbPositions = db.prepare(
      "SELECT * FROM auto_investments WHERE action='BUY' AND status='EXECUTED' ORDER BY created_at DESC"
    ).all();

    if (!dbPositions.length) {
      return res.json({ ok: true, message: 'No hay posiciones activas en DB para vender', results: [] });
    }

    console.log(`[SELL-ALL] 🔴 Iniciando venta de ${dbPositions.length} posiciones...`);
    const results = [];

    for (const pos of dbPositions) {
      const ticker = pos.ticker;
      const qty    = pos.quantity;
      const curr   = pos.currency || 'ARS';

      if (!ticker || qty <= 0) {
        results.push({ ticker, status: 'SKIP', reason: 'qty=0' });
        continue;
      }

      try {
        // Obtener quote actual con long_ticker correcto (incluye sufijo D para USD)
        console.log(`[SELL-ALL] Obteniendo quote ${ticker} (${curr})...`);
        const quote = await cocos.getQuote(ticker, 'C', curr);
        const longTicker  = quote?.long_ticker || '';
        const lastPrice   = quote?.last_price || quote?.close_price || quote?.previous_close_price || 0;
        const bidPrice    = quote?.bid || lastPrice;

        if (!longTicker) {
          results.push({ ticker, status: 'ERROR', reason: 'Sin long_ticker del quote' });
          console.error(`[SELL-ALL] ❌ ${ticker}: sin long_ticker`);
          continue;
        }
        if (lastPrice <= 0 && bidPrice <= 0) {
          results.push({ ticker, status: 'ERROR', reason: 'Sin precio (mercado cerrado?)' });
          console.error(`[SELL-ALL] ❌ ${ticker}: sin precio`);
          continue;
        }

        // Verificar selling power real
        let sellableQty = qty;
        try {
          const sp = await cocos.getSellingPower(longTicker);
          const spQty = sp?.quantity || sp?.available || sp?.max_quantity || 0;
          if (spQty > 0) sellableQty = Math.min(qty, spQty);
          console.log(`[SELL-ALL] ${ticker} selling power: ${spQty} (vendiendo ${sellableQty})`);
        } catch (e) {
          console.log(`[SELL-ALL] ${ticker} SP error (vendiendo ${qty} del DB): ${e.message}`);
        }

        if (sellableQty <= 0) {
          results.push({ ticker, long_ticker: longTicker, status: 'SKIP', reason: 'Selling power = 0' });
          continue;
        }

        // Precio: bid con 0.5% descuento para ejecución rápida, o last_price
        const sellPrice = bidPrice > 0
          ? Math.round(bidPrice * 0.995 * 100) / 100
          : Math.round(lastPrice * 0.99 * 100) / 100;

        console.log(`[SELL-ALL] 📤 SELL ${ticker} x${sellableQty} @ ${curr} $${sellPrice} via ${longTicker}`);
        const order   = await cocos.placeOrderByLongTicker(longTicker, 'SELL', sellableQty, sellPrice);
        const orderId = order?.Orden || order?.id || 'OK';

        // Registrar venta en DB
        const pnl = (sellPrice - pos.price) * sellableQty;
        db.prepare(`
          INSERT INTO auto_investments (ticker, action, quantity, price, total_ars, order_id, status, reason, currency)
          VALUES (?, 'SELL', ?, ?, ?, ?, 'EXECUTED', ?, ?)
        `).run(ticker, sellableQty, sellPrice, sellPrice * sellableQty, String(orderId),
               `SELL-ALL | Compra: $${pos.price} | PnL: ${curr} $${pnl.toFixed(2)}`, curr);

        // Marcar posición original como CLOSED
        db.prepare("UPDATE auto_investments SET status = 'CLOSED' WHERE id = ?").run(pos.id);

        results.push({
          ticker, long_ticker: longTicker, qty: sellableQty,
          buy_price: pos.price, sell_price: sellPrice, pnl: pnl.toFixed(2),
          order_id: orderId, status: 'SENT', currency: curr
        });
        console.log(`[SELL-ALL] ✅ ${ticker} x${sellableQty} @ ${curr} $${sellPrice} — #${orderId} | PnL: ${curr} $${pnl.toFixed(2)}`);

        await new Promise(r => setTimeout(r, 2000)); // esperar entre órdenes
      } catch (e) {
        results.push({ ticker, status: 'ERROR', error: e.message });
        console.error(`[SELL-ALL] ❌ Error vendiendo ${ticker}:`, e.message);
      }
    }

    // Desactivar auto-invest
    try { db.prepare("UPDATE auto_invest_config SET enabled = 0 WHERE id = 1").run(); } catch {}

    const sent = results.filter(r => r.status === 'SENT');
    const totalPnl = sent.reduce((s, r) => s + parseFloat(r.pnl || 0), 0);
    console.log(`[SELL-ALL] 🏁 Completado: ${sent.length}/${results.length} vendidas | PnL total: $${totalPnl.toFixed(2)}`);

    res.json({
      ok: true,
      sold: sent.length,
      total: results.length,
      total_pnl: totalPnl.toFixed(2),
      results,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.error('[SELL-ALL] Error fatal:', e.message);
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
