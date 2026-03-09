// src/services/auto-investor.js
// Sistema de inversión automática inteligente
// Invierte automáticamente al abrir el mercado en 3 CEDEARs diversificados
// Monitorea posiciones con stop-loss / take-profit / trailing stop

const { getDB }          = require('../models/db');
const { getOpenAIToken } = require('./ai-token');
const cocos              = require('./cocos');
const market             = require('./market-monitor');
const news               = require('./news-fetcher');
const rag                = require('./rag');

const CHECK_MS          = 60 * 1000;   // Chequear mercado cada 1 min
const MONITOR_MS        = 30 * 1000;   // Monitorear posiciones cada 30s
const OPENAI_MODEL      = 'gpt-4o-mini';
const NUM_POSITIONS     = 3;
const DISTRIBUTION      = [0.40, 0.35, 0.25];
const STOP_LOSS_PCT     = 5;
const TAKE_PROFIT_PCT   = 10;

// Horario operatoria: 10:40 a 17:00 ART (10min post apertura, evitar spreads)
function isMarketHours() {
  const now = new Date();
  // Convertir a hora Argentina (UTC-3)
  const utc  = now.getTime() + now.getTimezoneOffset() * 60000;
  const art  = new Date(utc - 3 * 3600000);
  const day  = art.getDay();       // 0=dom, 6=sab
  const hhmm = art.getHours() * 100 + art.getMinutes(); // ej 1030, 1700
  if (day === 0 || day === 6) return false;              // fin de semana
  return hhmm >= 1040 && hhmm < 1700;
}

const CANDIDATES = {
  'Tech/IA':           ['NVDA','TSLA','AMD','SMCI','PLTR','META','AAPL','MSFT','AMZN','GLOB'],
  'Energia/Petroleo':  ['YPFD','PAMP','VIST','XOM','CVX','OXY','XLE','PBR'],
  'ETF Diversificado': ['SPY','QQQ','SMH','GLD'],
  'Bancos/Finanzas':   ['GGAL','BBAR','BMA','SUPV'],
};

let _checkTimer   = null;
let _monitorTimer = null;
let _broadcastFn  = null;

// Verificar en DB si ya se invirtió hoy (persiste entre restarts de PM2)
function _alreadyInvestedToday() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const row = getDB().prepare(
      "SELECT COUNT(*) as c FROM auto_investments WHERE action='BUY' AND status IN ('EXECUTED','PENDING') AND date(created_at) = ?"
    ).get(today);
    return row.c > 0;
  } catch { return false; }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function getAutoConfig() {
  const db = getDB();
  let cfg = db.prepare('SELECT * FROM auto_invest_config WHERE id = 1').get();
  if (!cfg) {
    db.prepare('INSERT INTO auto_invest_config (id) VALUES (1)').run();
    cfg = db.prepare('SELECT * FROM auto_invest_config WHERE id = 1').get();
  }
  return cfg;
}

function updateAutoConfig(changes) {
  const db     = getDB();
  const fields = Object.keys(changes).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE auto_invest_config SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`)
    .run(...Object.values(changes));
  return getAutoConfig();
}

function saveInvestment(inv) {
  const db = getDB();
  try { db.prepare("ALTER TABLE auto_investments ADD COLUMN currency TEXT DEFAULT 'ARS'").run(); } catch {}
  return db.prepare(`
    INSERT INTO auto_investments
      (ticker, action, quantity, price, total_ars, order_id, status,
       stop_loss_price, take_profit_price, reason, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    inv.ticker, inv.action, inv.quantity || 0, inv.price || 0,
    inv.total_ars || 0, inv.order_id || '', inv.status || 'PENDING',
    inv.stop_loss_price || 0, inv.take_profit_price || 0, inv.reason || '',
    inv.currency || 'ARS'
  );
}

function getActivePositions() {
  return getDB().prepare(`
    SELECT * FROM auto_investments
    WHERE action = 'BUY' AND status = 'EXECUTED'
    ORDER BY created_at DESC
  `).all();
}

function getInvestmentHistory(limit) {
  return getDB().prepare(
    'SELECT * FROM auto_investments ORDER BY created_at DESC LIMIT ?'
  ).all(limit || 50);
}

function markClosed(id) {
  getDB().prepare(
    "UPDATE auto_investments SET status = 'CLOSED' WHERE id = ?"
  ).run(id);
}

// ── Selección IA ──────────────────────────────────────────────────────────────

async function selectBestTickers() {
  const allTickers = Object.values(CANDIDATES).flat();

  // Datos técnicos
  const rows = [];
  for (const t of allTickers) {
    const ind = market.getIndicators(t);
    const lp  = market.getLatestPrice(t);
    if (ind && ind.price > 0)
      rows.push(`${t}: $${ind.price.toFixed(2)} | Var:${(lp?.variation||0)>=0?'+':''}${(lp?.variation||0).toFixed(1)}% | RSI:${ind.rsi??'N/D'} | SMA20:${ind.sma20?'$'+ind.sma20.toFixed(0):'N/D'} | Tend5:${ind.trend5}%`);
  }
  const marketCtx = rows.join('\n') || 'Sin datos de mercado aún.';

  // Noticias
  const newsItems = news.getNewsForTickers(allTickers, 20);
  const newsCtx   = newsItems.length
    ? newsItems.map(n => `[${n.source}] ${n.title}`).join('\n')
    : 'Sin noticias recientes.';

  // RAG (keywords, sin embedding = gratis)
  const ragCtx = await rag.buildRAGContext(
    'mejor inversion CEDEAR tecnologia energia petroleo rendimiento seguro diversificado estrategia', false
  );

  const prompt = `SELECCION AUTOMATICA DE INVERSION — AutoTrader

Eres un experto en inversiones en CEDEARs y acciones argentinas (BYMA).
Debes seleccionar EXACTAMENTE 3 activos para invertir HOY.

REGLAS:
1. Seleccionar EXACTAMENTE 3 tickers diferentes
2. OBLIGATORIO: EXACTAMENTE 2 de Energia/Petroleo y 1 de Tecnología/IA
3. Priorizar los activos que MAS ESTAN SUBIENDO hoy (mayor variación positiva)
4. Priorizar activos con tendencia alcista (trend5 positivo, RSI 30-70)
5. Evitar activos con RSI > 80 (muy sobrecomprados)
6. Evitar activos con trend5 < -5% (tendencia bajista fuerte)
7. NO PERDER DINERO es la prioridad máxima
8. Distribuir: 40% primer activo (mejor energía), 35% segundo (segunda energía), 25% tercero (mejor tech)
9. Ordenar: primero las 2 energéticas, luego la tecnológica

CANDIDATOS:
Energia/Petroleo: ${CANDIDATES['Energia/Petroleo'].join(', ')}
Tech/IA: ${CANDIDATES['Tech/IA'].join(', ')}
ETF: ${CANDIDATES['ETF Diversificado'].join(', ')}
Bancos: ${CANDIDATES['Bancos/Finanzas'].join(', ')}

DATOS TECNICOS:
${marketCtx}

NOTICIAS FINANCIERAS:
${newsCtx}
${ragCtx ? `\nCONOCIMIENTO DEL USUARIO:\n${ragCtx}` : ''}

RESPONDE SOLO JSON:
{
  "selections": [
    {"ticker":"PBR","category":"Energia","confidence":0.88,"reason":"Petróleo subiendo +5%"},
    {"ticker":"VIST","category":"Energia","confidence":0.82,"reason":"Vaca Muerta alcista"},
    {"ticker":"NVDA","category":"Tech/IA","confidence":0.80,"reason":"Líder IA con momentum"}
  ],
  "market_outlook":"BULLISH|BEARISH|NEUTRAL",
  "risk_assessment":"LOW|MEDIUM|HIGH",
  "reasoning":"Explicación breve"
}`;

  const apiKey = await getOpenAIToken();
  if (!apiKey) throw new Error('Sin token OpenAI');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_MODEL, temperature: 0.2, max_tokens: 1000,
      messages: [
        { role: 'system', content: 'Eres un agente de trading experto en BYMA/Merval y CEDEARs argentinos. Seleccionas las mejores inversiones basándote en datos técnicos, noticias y conocimiento del usuario. Conservador. JSON válido siempre.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error: ${res.status}`);
  return JSON.parse((await res.json()).choices[0].message.content);
}

// ── Inversión principal ───────────────────────────────────────────────────────

async function executeAutoInvest() {
  const cfg = getAutoConfig();
  if (!cfg.enabled) return null;
  if (!cocos.isReady()) { console.log('[AutoInvest] Cocos no conectado'); return null; }

  // Mercado abierto? (API Cocos + fallback horario local 10:30-17:00 ART L-V)
  let marketOpen = false;
  try {
    const ms = await cocos.getMarketStatus();
    marketOpen = !!(ms?.['24hs'] || ms?.CI);
  } catch {}
  // Fallback: si la API no responde, usar horario local
  if (!marketOpen) marketOpen = isMarketHours();
  if (!marketOpen) return null;

  // Ya invertido hoy? (check en DB — sobrevive restarts PM2)
  if (!_forceOverride && _alreadyInvestedToday()) return null;

  console.log('[AutoInvest] 🚀 Mercado abierto — iniciando inversión automática…');

  // Detectar moneda principal y poder de compra
  let primaryCurrency = 'ARS';
  let buyingPower = 0;
  let dolarMEP = 1200;
  try {
    const bp = await cocos.getBuyingPower();
    const arsCapital = bp?.['24hs']?.ars || 0;
    const usdCapital = bp?.['24hs']?.usd || 0;

    // Obtener dólar MEP para conversiones
    try {
      const mep = await cocos.getDolarMEP();
      dolarMEP = mep?.venta || mep?.compra || mep?.price || 1200;
    } catch {}

    if (usdCapital > 10 && arsCapital < 5000) {
      // Capital mayormente en USD — operar en dólares
      primaryCurrency = 'USD';
      buyingPower = usdCapital;
      console.log(`[AutoInvest] Capital en USD: $${usdCapital.toFixed(2)} — operando en dólares`);
    } else if (usdCapital > 10) {
      // Capital mixto — convertir USD a ARS equivalente
      const usdInArs = Math.floor(usdCapital * dolarMEP);
      buyingPower = arsCapital + usdInArs;
      console.log(`[AutoInvest] Mixto: ARS $${arsCapital} + USD $${usdCapital.toFixed(2)} × MEP $${dolarMEP} = Total ARS $${buyingPower}`);
    } else {
      buyingPower = arsCapital;
    }
    console.log(`[AutoInvest] Poder de compra: ${primaryCurrency} $${buyingPower.toFixed(2)}`);
  } catch (e) {
    console.error('[AutoInvest] Error poder de compra:', e.message);
    return null;
  }

  // Min invest ajustado por moneda (10000 ARS ≈ $8 USD)
  const minInvestArs = cfg.min_invest_ars || 10000;
  const minInvest = primaryCurrency === 'USD' ? Math.max(10, minInvestArs / dolarMEP) : minInvestArs;
  if (buyingPower < minInvest) {
    console.log(`[AutoInvest] Capital insuficiente: ${primaryCurrency} $${buyingPower.toFixed(2)} (mín ${primaryCurrency} $${minInvest.toFixed(2)})`);
    return null;
  }

  const investPct    = (cfg.invest_pct || 50) / 100;
  const totalInvest  = primaryCurrency === 'USD' ? Math.round(buyingPower * investPct * 100) / 100 : Math.floor(buyingPower * investPct);
  console.log(`[AutoInvest] Capital: ${primaryCurrency} $${buyingPower.toFixed(2)} → Invertir: ${primaryCurrency} $${totalInvest} (${cfg.invest_pct||50}%)`);

  // IA selecciona los 3 mejores
  let selection;
  try {
    selection = await selectBestTickers();
    console.log(`[AutoInvest] IA seleccionó: ${selection.selections.map(s=>s.ticker).join(', ')} | ${selection.market_outlook}`);
  } catch (e) {
    console.error('[AutoInvest] Error selección IA:', e.message);
    selection = {
      selections: [
        { ticker: 'PBR',  category: 'Energia',   confidence: 0.75, reason: 'Fallback — petróleo en alza' },
        { ticker: 'VIST', category: 'Energia',   confidence: 0.70, reason: 'Fallback — Vaca Muerta' },
        { ticker: 'NVDA', category: 'Tech/IA',   confidence: 0.70, reason: 'Fallback — líder IA' },
      ],
      market_outlook: 'NEUTRAL',
      risk_assessment: 'MEDIUM',
      reasoning: 'Selección fallback por error en IA',
    };
  }

  if (selection.risk_assessment === 'HIGH' && !cfg.allow_high_risk) {
    console.log('[AutoInvest] ⚠️ Riesgo alto — no se invierte hoy');
    return { skipped: true, reason: 'Riesgo alto', selection };
  }

  // Colocar órdenes — si una falla, redistribuir su capital a las siguientes
  const stopPct = cfg.stop_loss_pct   || STOP_LOSS_PCT;
  const tpPct   = cfg.take_profit_pct || TAKE_PROFIT_PCT;
  const results = [];
  let remainingCapital = totalInvest;

  for (let i = 0; i < Math.min(selection.selections.length, NUM_POSITIONS); i++) {
    const sel = selection.selections[i];
    // Calcular allocation: proporción original sobre lo que queda
    const remainingSlots = NUM_POSITIONS - i;
    const originalPct    = DISTRIBUTION[i];
    const totalRemPct    = DISTRIBUTION.slice(i).reduce((a, b) => a + b, 0);
    const allocation     = Math.floor(remainingCapital * (originalPct / totalRemPct));

    try {
      const quote = await cocos.getQuote(sel.ticker, 'C', primaryCurrency);
      // Usar ask × 1.002 para asegurar ejecución (last_price como fallback)
      const askPrice  = quote?.ask || 0;
      const lastPrice = quote?.last_price || quote?.close_price || quote?.previous_close_price || 0;
      const price     = askPrice > 0 ? Math.round(askPrice * 1.002 * 100) / 100 : lastPrice;
      if (price <= 0) { console.warn(`[AutoInvest] Sin precio ${sel.ticker} (${primaryCurrency})`); continue; }

      const quantity   = Math.max(1, Math.floor(allocation / price));
      const total      = quantity * price;
      const stopLoss   = Math.round(price * (1 - stopPct / 100) * 100) / 100;
      const takeProfit = Math.round(price * (1 + tpPct  / 100) * 100) / 100;

      console.log(`[AutoInvest] 📈 BUY ${sel.ticker}: ${quantity}x @ ${primaryCurrency} $${price} = ${primaryCurrency} $${total} | SL:$${stopLoss} TP:$${takeProfit}`);

      const order   = await cocos.placeBuyOrder(sel.ticker, quantity, price, '24hs', primaryCurrency, 'C');
      const orderId = order?.Orden || order?.id || '';

      // Verificar estado real de la orden (esperar 2s para que Cocos procese)
      let orderStatus = 'PENDING';
      if (orderId && orderId !== 'OK') {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const status = await cocos.getOrderStatus(orderId);
          orderStatus = status?.status || status?.state || 'PENDING';
          if (['FILLED', 'COMPLETED', 'EXECUTED'].includes(orderStatus.toUpperCase())) {
            orderStatus = 'EXECUTED';
          }
        } catch { orderStatus = 'PENDING'; }
      } else {
        orderStatus = 'EXECUTED';
      }

      const inv = {
        ticker: sel.ticker, action: 'BUY', quantity, price, total_ars: total,
        order_id: orderId, status: orderStatus,
        stop_loss_price: stopLoss, take_profit_price: takeProfit,
        currency: primaryCurrency,
        reason: `${sel.reason} | Confianza: ${(sel.confidence*100).toFixed(0)}% | ${sel.category} | ${primaryCurrency}`,
      };
      saveInvestment(inv);
      results.push(inv);
      remainingCapital -= total;
      console.log(`[AutoInvest] ✅ Orden ${orderStatus}: ${sel.ticker} x${quantity} — #${orderId} | Restante: ${primaryCurrency} $${remainingCapital.toFixed(2)}`);

      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`[AutoInvest] ❌ Error comprando ${sel.ticker}:`, e.message);
      saveInvestment({ ticker: sel.ticker, action: 'BUY', quantity: 0, price: 0, total_ars: 0, status: 'FAILED', reason: `Error: ${e.message}` });
    }
  }

  const summary = {
    type: 'auto_invest',
    invested: results.length,
    total_invested: results.reduce((s, r) => s + r.total_ars, 0),
    currency: primaryCurrency,
    positions: results.map(r => ({ ticker: r.ticker, qty: r.quantity, price: r.price })),
    selection,
    timestamp: new Date().toISOString(),
  };
  console.log(`[AutoInvest] 🎯 Completado: ${results.length} posiciones | Total: ${primaryCurrency} $${summary.total_invested.toFixed(2)}`);
  if (_broadcastFn) _broadcastFn(summary);
  return summary;
}

// ── Monitor de posiciones (stop-loss / take-profit / trailing) ────────────────

async function monitorPositions() {
  const cfg = getAutoConfig();
  if (!cfg.enabled || !cfg.monitor_enabled) return;
  if (!cocos.isReady()) return;

  let marketOpen = false;
  try { const ms = await cocos.getMarketStatus(); marketOpen = !!(ms?.['24hs']||ms?.CI); } catch {}
  if (!marketOpen) marketOpen = isMarketHours();
  if (!marketOpen) return;

  const positions = getActivePositions();
  if (!positions.length) return;

  for (const pos of positions) {
    try {
      const curr         = pos.currency || 'ARS';
      const quote        = await cocos.getQuote(pos.ticker, 'C', curr);
      const currentPrice = quote?.last_price || quote?.close_price || 0;
      if (currentPrice <= 0) continue;

      const pnlPct = ((currentPrice - pos.price) / pos.price) * 100;

      // Stop-Loss
      if (pos.stop_loss_price > 0 && currentPrice <= pos.stop_loss_price) {
        console.log(`[AutoInvest] 🛑 STOP-LOSS ${pos.ticker}: ${curr} $${currentPrice} <= $${pos.stop_loss_price} (${pnlPct.toFixed(1)}%)`);
        await executeSell(pos, currentPrice, `Stop-loss: ${pnlPct.toFixed(1)}%`);
        continue;
      }

      // Take-Profit
      if (pos.take_profit_price > 0 && currentPrice >= pos.take_profit_price) {
        console.log(`[AutoInvest] 🎉 TAKE-PROFIT ${pos.ticker}: ${curr} $${currentPrice} >= $${pos.take_profit_price} (+${pnlPct.toFixed(1)}%)`);
        await executeSell(pos, currentPrice, `Take-profit: +${pnlPct.toFixed(1)}%`);
        continue;
      }

      // Trailing stop: ganancia > 7% → subir SL a precio de compra +2%
      if (pnlPct > 7 && pos.stop_loss_price < pos.price) {
        const newSL = Math.round(pos.price * 1.02 * 100) / 100;
        getDB().prepare('UPDATE auto_investments SET stop_loss_price = ? WHERE id = ?').run(newSL, pos.id);
        console.log(`[AutoInvest] 📊 Trailing ${pos.ticker}: SL → $${newSL}`);
      }

      await new Promise(r => setTimeout(r, 500));
    } catch { /* continuar */ }
  }
}

async function executeSell(position, currentPrice, reason) {
  try {
    const curr    = position.currency || 'ARS';
    const order   = await cocos.placeSellOrder(position.ticker, position.quantity, currentPrice, '24hs', curr, 'C');
    const orderId = order?.Orden || order?.id || 'OK';
    const pnl     = (currentPrice - position.price) * position.quantity;

    saveInvestment({
      ticker: position.ticker, action: 'SELL', quantity: position.quantity,
      price: currentPrice, total_ars: currentPrice * position.quantity,
      order_id: orderId, status: 'EXECUTED', currency: curr,
      reason: `${reason} | PnL: ${curr} $${pnl.toFixed(2)}`,
    });

    markClosed(position.id);

    console.log(`[AutoInvest] 💰 SELL ${position.ticker} x${position.quantity} @ ${curr} $${currentPrice} | PnL: ${curr} $${pnl.toFixed(2)}`);
    if (_broadcastFn) _broadcastFn({
      type: 'auto_sell', ticker: position.ticker, quantity: position.quantity,
      buy_price: position.price, sell_price: currentPrice, pnl, reason,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`[AutoInvest] Error vendiendo ${position.ticker}:`, e.message);
  }
}

// ── Forzar inversión manual ───────────────────────────────────────────────────

let _forceOverride = false;

async function forceInvest() {
  _forceOverride = true;
  try { return await executeAutoInvest(); }
  finally { _forceOverride = false; }
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init(broadcastFn) {
  _broadcastFn = broadcastFn;

  if (_checkTimer)   clearInterval(_checkTimer);
  if (_monitorTimer) clearInterval(_monitorTimer);

  _checkTimer = setInterval(async () => {
    try { await executeAutoInvest(); } catch (e) { console.error('[AutoInvest]', e.message); }
  }, CHECK_MS);

  _monitorTimer = setInterval(async () => {
    try { await monitorPositions(); } catch (e) { console.error('[AutoInvest] Monitor:', e.message); }
  }, MONITOR_MS);

  console.log('[AutoInvest] Sistema de inversión automática iniciado — check cada 1 min, monitor cada 30s');

  // Primer intento tras 15s (dar tiempo a que Cocos se conecte)
  setTimeout(async () => {
    try { await executeAutoInvest(); } catch (e) { console.error('[AutoInvest] Inicial:', e.message); }
  }, 15000);
}

module.exports = {
  init,
  getAutoConfig,
  updateAutoConfig,
  executeAutoInvest,
  monitorPositions,
  forceInvest,
  getActivePositions,
  getInvestmentHistory,
};
