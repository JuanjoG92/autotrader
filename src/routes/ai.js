// src/routes/ai.js
// Rutas del agente de IA y monitor de mercado

const express  = require('express');
const router   = express.Router();
const auth     = require('../middleware/auth');
const aiTrader = require('../services/ai-trader');
const market   = require('../services/market-monitor');
const news     = require('../services/news-fetcher');
const cocos    = require('../services/cocos');
const autoInv  = require('../services/auto-investor');

const OWNER_ID = parseInt(process.env.COCOS_OWNER_USER_ID || '1');
function ownerOnly(req, res, next) {
  if (req.userId !== OWNER_ID) return res.status(403).json({ error: 'Solo el propietario' });
  next();
}

// ── Estado y config del agente ────────────────────────────────────────────────

// GET /api/ai/config
router.get('/config', auth, ownerOnly, (req, res) => {
  res.json(aiTrader.getConfig());
});

// PUT /api/ai/config
// Body: { enabled, auto_execute, max_per_trade_ars, min_confidence, risk_level }
router.put('/config', auth, ownerOnly, (req, res) => {
  const allowed = ['enabled', 'auto_execute', 'max_per_trade_ars', 'min_confidence', 'risk_level'];
  const changes = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) changes[k] = req.body[k];
  }
  if (Object.keys(changes).length === 0) return res.status(400).json({ error: 'Nada que actualizar' });
  res.json(aiTrader.updateConfig(changes));
});

// POST /api/ai/analyze   — forzar análisis ahora
router.post('/analyze', auth, ownerOnly, async (req, res) => {
  try {
    // Auto-habilitar temporalmente para el análisis manual
    const cfg = aiTrader.getConfig();
    if (!cfg.enabled) aiTrader.updateConfig({ enabled: 1 });
    const result = await aiTrader.runAnalysis();
    res.json(result || { signals: [], analysis: 'Sin análisis disponible' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/ai/analyze-ticker   — análisis individual de un ticker
router.post('/analyze-ticker', auth, ownerOnly, async (req, res) => {
  try {
    const { ticker } = req.body;
    if (!ticker) return res.status(400).json({ error: 'ticker requerido' });
    const result = await aiTrader.runTickerAnalysis(ticker);
    res.json(result || { error: 'Sin resultado' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ai/signals   — historial de señales
router.get('/signals', auth, ownerOnly, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(aiTrader.getRecentSignals(limit));
});

// ── Monitor de mercado ────────────────────────────────────────────────────────

// GET /api/ai/market/prices   — precios actuales + fallback watchlist
router.get('/market/prices', auth, async (req, res) => {
  try {
    // Datos del monitor de 30s (DB)
    const prices = market.getAllLatestPrices();
    const withPrice = prices.filter(p => p.price > 0);

    if (withPrice.length > 0) {
      return res.json(withPrice.map(p => ({ ...p, indicators: market.getIndicators(p.ticker) })));
    }

    // Fallback: mostrar watchlist con último precio conocido (puede ser 0 si mercado cerrado)
    const watchlist = market.getActiveWatchlist();
    const result = watchlist.map(w => {
      const latest = market.getLatestPrice(w.ticker);
      const ind    = market.getIndicators(w.ticker);
      return {
        ticker:     w.ticker,
        price:      latest?.price || 0,
        variation:  latest?.variation || 0,
        volume:     latest?.volume || 0,
        timestamp:  latest?.timestamp || null,
        indicators: ind,
      };
    });

    // Si Cocos está disponible, intentar actualizar precios en background
    if (cocos.isReady() && result.every(r => r.price === 0)) {
      market.pollOnce().catch(() => {});
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ai/market/history/:ticker?days=30
router.get('/market/history/:ticker', auth, (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const history = market.getPriceHistory(req.params.ticker.toUpperCase(), days);
  res.json(history);
});

// GET /api/ai/market/watchlist
router.get('/market/watchlist', auth, (req, res) => {
  res.json(market.getActiveWatchlist());
});

// POST /api/ai/market/watchlist   — agregar instrumento
// Body: { ticker, instrument_type, segment, currency }
router.post('/market/watchlist', auth, ownerOnly, (req, res) => {
  const { ticker, instrument_type, segment, currency } = req.body;
  if (!ticker) return res.status(400).json({ error: 'ticker requerido' });
  const ok = market.addToWatchlist(ticker, instrument_type, segment, currency);
  res.json({ ok, ticker: ticker.toUpperCase() });
});

// DELETE /api/ai/market/watchlist/:ticker
router.delete('/market/watchlist/:ticker', auth, ownerOnly, (req, res) => {
  market.removeFromWatchlist(req.params.ticker);
  res.json({ ok: true });
});

// POST /api/ai/market/poll   — forzar actualización de precios
router.post('/market/poll', auth, ownerOnly, async (req, res) => {
  try {
    const results = await market.pollOnce();
    res.json({ ok: true, updated: results?.length || 0, tickers: results?.map(r => r.ticker) || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ai/news
router.get('/news', auth, (req, res) => {
  res.json(news.getLatestNews(30));
});

// POST /api/ai/news/fetch
router.post('/news/fetch', auth, ownerOnly, async (req, res) => {
  try {
    const count = await news.fetchAllFeeds();
    res.json({ ok: true, fetched: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Auto-Investor ─────────────────────────────────────────────────────────────

// GET /api/ai/auto-invest/config
router.get('/auto-invest/config', auth, ownerOnly, (req, res) => {
  res.json(autoInv.getAutoConfig());
});

// PUT /api/ai/auto-invest/config
router.put('/auto-invest/config', auth, ownerOnly, (req, res) => {
  const allowed = ['enabled','monitor_enabled','invest_pct','min_invest_ars','stop_loss_pct','take_profit_pct','allow_high_risk','num_positions'];
  const changes = {};
  for (const k of allowed) { if (req.body[k] !== undefined) changes[k] = req.body[k]; }
  if (!Object.keys(changes).length) return res.status(400).json({ error: 'Nada que actualizar' });
  res.json(autoInv.updateAutoConfig(changes));
});

// POST /api/ai/auto-invest/execute  — forzar inversión ahora
router.post('/auto-invest/execute', auth, ownerOnly, async (req, res) => {
  try {
    const result = await autoInv.forceInvest();
    res.json(result || { ok: false, message: 'No se pudo invertir (mercado cerrado o sin capital)' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ai/auto-invest/positions  — posiciones activas
router.get('/auto-invest/positions', auth, ownerOnly, (req, res) => {
  res.json(autoInv.getActivePositions());
});

// GET /api/ai/auto-invest/history  — historial completo
router.get('/auto-invest/history', auth, ownerOnly, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(autoInv.getInvestmentHistory(limit));
});

// POST /api/ai/auto-invest/monitor  — forzar monitoreo ahora
router.post('/auto-invest/monitor', auth, ownerOnly, async (req, res) => {
  try {
    await autoInv.monitorPositions();
    res.json({ ok: true, positions: autoInv.getActivePositions().length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
