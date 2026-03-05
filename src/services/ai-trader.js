// src/services/ai-trader.js
// Agente IA — análisis sectorial + noticias + RAG + filtros configurables
// v2

const { getDB }          = require('../models/db');
const { getOpenAIToken } = require('./ai-token');
const cocos              = require('./cocos');
const market             = require('./market-monitor');
const news               = require('./news-fetcher');
const rag                = require('./rag');

const ANALYSIS_MS  = 5 * 60 * 1000;
const OPENAI_MODEL = 'gpt-4o-mini';

const ALL_SECTORS = {
  'Energia/Petroleo': ['YPFD', 'PAMP', 'TGNO4', 'TGSU2', 'CEPU', 'XOM', 'CVX'],
  'Bancos/Finanzas':  ['GGAL', 'BBAR', 'BMA', 'SUPV'],
  'Materiales':       ['ALUA', 'LOMA', 'TXAR'],
  'Tech Global':      ['AAPL', 'MSFT', 'GOOGL', 'NVDA', 'META', 'AMZN', 'TSLA'],
  'Latam/Otros':      ['MELI', 'TECO2'],
};

const CEDEARS  = new Set(['AAPL','MSFT','GOOGL','NVDA','META','AMZN','TSLA','XOM','CVX','MELI']);
const ACCIONES = new Set(['YPFD','PAMP','TGNO4','TGSU2','CEPU','GGAL','BBAR','BMA','SUPV','ALUA','LOMA','TXAR','TECO2']);

let _analysisTimer = null;
let _broadcastFn   = null;

// ── Config ────────────────────────────────────────────────────────────────────

function getConfig() {
  const db = getDB();
  let cfg = db.prepare('SELECT * FROM ai_config WHERE id = 1').get();
  if (!cfg) { db.prepare('INSERT INTO ai_config (id) VALUES (1)').run(); cfg = db.prepare('SELECT * FROM ai_config WHERE id = 1').get(); }
  return cfg;
}

function updateConfig(changes) {
  const db = getDB();
  const newCols = {
    sectors: 'TEXT DEFAULT "all"', asset_types: 'TEXT DEFAULT "BOTH"',
    news_driven: 'INTEGER DEFAULT 1', news_weight: 'REAL DEFAULT 0.5',
    use_rag: 'INTEGER DEFAULT 1', max_positions: 'INTEGER DEFAULT 5',
    stop_loss_pct: 'REAL DEFAULT 5.0', take_profit_pct: 'REAL DEFAULT 10.0',
  };
  for (const [col, def] of Object.entries(newCols)) {
    try { db.prepare(`ALTER TABLE ai_config ADD COLUMN ${col} ${def}`).run(); } catch {}
  }
  const fields = Object.keys(changes).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE ai_config SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...Object.values(changes), 1);
  return getConfig();
}

// ── Señales ───────────────────────────────────────────────────────────────────

function saveSignal(s) {
  return getDB().prepare(
    'INSERT INTO ai_signals (ticker, action, confidence, price, quantity, reason, analysis) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(s.ticker, s.action, s.confidence, s.price || 0, s.quantity || 0, s.reason || '', s.analysis || '');
}

function getRecentSignals(limit) {
  return getDB().prepare('SELECT * FROM ai_signals ORDER BY created_at DESC LIMIT ?').all(limit || 20);
}

function markSignalExecuted(id, orderId) {
  getDB().prepare('UPDATE ai_signals SET executed = 1, order_id = ? WHERE id = ?').run(orderId || '', id);
}

// ── Filtros ───────────────────────────────────────────────────────────────────

function getActiveTickers(cfg) {
  const sectorFilter = cfg.sectors || 'all';
  const typeFilter   = cfg.asset_types || 'BOTH';
  let tickers = [];

  if (sectorFilter === 'all') {
    tickers = Object.values(ALL_SECTORS).flat();
  } else {
    const active = sectorFilter.split(',').map(s => s.trim().toLowerCase());
    for (const [sector, list] of Object.entries(ALL_SECTORS)) {
      if (active.some(s => sector.toLowerCase().includes(s))) tickers.push(...list);
    }
  }
  if (typeFilter === 'ACCIONES') tickers = tickers.filter(t => ACCIONES.has(t));
  else if (typeFilter === 'CEDEARS') tickers = tickers.filter(t => CEDEARS.has(t));
  return [...new Set(tickers)];
}

// ── Contexto mercado ──────────────────────────────────────────────────────────

function buildMarketContext(tickers) {
  const lines = [];
  for (const [sector, list] of Object.entries(ALL_SECTORS)) {
    const filtered = list.filter(t => tickers.includes(t));
    if (!filtered.length) continue;
    lines.push(`[${sector}]`);
    for (const ticker of filtered) {
      const ind = market.getIndicators(ticker);
      if (!ind || ind.price <= 0 || ind.dataPoints < 2) { lines.push(`  ${ticker}: sin datos suficientes`); continue; }
      const v = market.getLatestPrice(ticker)?.variation || 0;
      lines.push(`  ${ticker}: $${ind.price.toFixed(2)} | Var:${v>=0?'+':''}${v.toFixed(1)}% | RSI:${ind.rsi??'N/D'} | SMA20:${ind.sma20?'$'+ind.sma20.toFixed(0):'N/D'} | SMA50:${ind.sma50?'$'+ind.sma50.toFixed(0):'N/D'} | Tend5p:${ind.trend5}%`);
    }
  }
  return lines.join('\n') || 'Mercado cerrado o sin datos.';
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

async function callOpenAI(prompt) {
  const apiKey = await getOpenAIToken();
  if (!apiKey) throw new Error('Sin token OpenAI');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_MODEL, temperature: 0.25, max_tokens: 2500,
      messages: [
        { role: 'system', content: `Eres un agente de trading experto en BYMA/Merval y CEDEARs argentinos.
Analizas tecnico + noticias + documentos para generar señales de inversion. JSON valido siempre.
Cuando usas noticias, las citas en el "reason". Conservador con el capital. No perder es prioridad.` },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(`OpenAI ${res.status}: ${e.error?.message}`); }
  return JSON.parse((await res.json()).choices[0].message.content);
}

// ── Analisis principal ────────────────────────────────────────────────────────

async function runAnalysis() {
  const cfg = getConfig();
  if (!cfg.enabled) return null;
  if (!cocos.isReady()) return null;
  console.log('[AI-Trader] Iniciando analisis...');

  const tickers   = getActiveTickers(cfg);
  const marketCtx = buildMarketContext(tickers);
  const newsItems = cfg.news_driven !== 0 ? news.getNewsForTickers(tickers, 15) : [];
  const newsCtx   = newsItems.length ? newsItems.map(n => `[${n.source}] ${n.title}`).join('\n') : 'Sin noticias recientes.';
  const ragCtx    = cfg.use_rag !== 0 ? await rag.buildRAGContext('mercado argentino acciones cedear inversion ' + tickers.join(' ')) : '';

  let portfolio = 'Sin posiciones', buyingPower = 'Sin datos', marketOpen = false;
  try { const bp = await cocos.getBuyingPower(); buyingPower = `ARS $${(bp?.['24hs']?.ars||0).toLocaleString()} | USD $${(bp?.['24hs']?.usd||0).toFixed(2)}`; } catch {}
  try { const p = await cocos.getPortfolio(); if (p?.positions?.length) portfolio = p.positions.map(x => `${x.ticker||x.instrument_code}: ${x.quantity}uds`).join(' | '); } catch {}
  try { const ms = await cocos.getMarketStatus(); marketOpen = !!(ms?.['24hs']||ms?.CI); } catch {}

  const newsInstr = cfg.news_driven !== 0
    ? `INVERSION POR NOTICIAS ACTIVADA (peso: ${Math.round((cfg.news_weight||0.5)*100)}%). Noticia positiva confirmada → BUY. Noticia negativa confirmada → SELL. Citar la noticia en reason.`
    : 'Solo analisis tecnico (sin noticias).';
  const typeInstr = cfg.asset_types==='ACCIONES' ? 'Solo ACCIONES argentinas (BYMA).'
                  : cfg.asset_types==='CEDEARS'  ? 'Solo CEDEARs (acciones ext. en pesos).'
                  : 'Acciones y CEDEARs.';

  const prompt = `ANALISIS TRADING AUTOMATIZADO COCOS CAPITAL

MERCADO: ${marketOpen?'ABIERTO':'CERRADO (preparar para apertura)'}
PODER COMPRA: ${buyingPower} | MAX/OP: ARS $${cfg.max_per_trade_ars} | RIESGO: ${cfg.risk_level}
STOP LOSS: ${cfg.stop_loss_pct||5}% | TAKE PROFIT: ${cfg.take_profit_pct||10}%
CARTERA: ${portfolio}

FILTROS: ${typeInstr} | Sectores: ${cfg.sectors==='all'?'Todos':cfg.sectors}
${newsInstr}

=== DATOS TECNICOS POR SECTOR ===
${marketCtx}

=== NOTICIAS FINANCIERAS (USAR PARA INVERTIR SI news_driven=1) ===
${newsCtx}
${ragCtx?`\n=== DOCUMENTOS PERSONALES DEL USUARIO ===\n${ragCtx}`:''}

=== REGLAS DE DECISION ===
1. RSI<30 + noticia positiva = BUY alta confianza
2. RSI>70 + noticia negativa = SELL alta confianza
3. Precio>SMA20>SMA50 + noticia positiva = BUY media-alta confianza
4. Noticia muy positiva sin datos tecnicos = BUY confianza moderada (0.65-0.75)
5. quantity = floor(max_per_trade_ars / precio_actual), minimo 1
6. Max ${cfg.max_positions||5} señales por analisis

RESPONDE SOLO JSON:
{
  "signals":[{"ticker":"YPFD","sector":"Energia/Petroleo","action":"BUY","confidence":0.82,"price":24500,"quantity":2,"reason":"RSI 28 + noticia: YPF anuncia expansion Vaca Muerta","news_driven":true}],
  "sector_analysis":{"Energia/Petroleo":"texto breve","Bancos/Finanzas":"texto breve"},
  "analysis":"Resumen ejecutivo 2-3 oraciones",
  "market_sentiment":"BULLISH|BEARISH|NEUTRAL",
  "macro_note":"Contexto macro argentino"
}`;

  let result;
  try { result = await callOpenAI(prompt); } catch (e) { console.error('[AI-Trader] Error OpenAI:', e.message); return null; }

  const signals = result.signals || [];
  console.log(`[AI-Trader] ${signals.length} señales | ${result.market_sentiment}`);

  for (const sig of signals) {
    if (!sig.ticker || sig.confidence < cfg.min_confidence) continue;
    const saved = saveSignal({ ...sig, analysis: result.analysis });
    if (cfg.auto_execute && marketOpen && sig.price > 0 && sig.quantity > 0) {
      try {
        let ord;
        if (sig.action==='BUY')  ord = await cocos.placeBuyOrder(sig.ticker, sig.quantity, sig.price, '24hs', 'ARS', 'C');
        if (sig.action==='SELL') ord = await cocos.placeSellOrder(sig.ticker, sig.quantity, sig.price, '24hs', 'ARS', 'C');
        if (ord) { markSignalExecuted(saved.lastInsertRowid, ord.Orden||ord.id||'OK'); console.log(`[AI-Trader] Ejecutado: ${sig.action} ${sig.ticker} x${sig.quantity}`); }
      } catch (e) { console.error(`[AI-Trader] Error ejecutando ${sig.ticker}:`, e.message); }
    }
  }

  if (_broadcastFn) _broadcastFn({ type: 'ai_analysis', data: result, timestamp: new Date().toISOString() });
  return result;
}

function init(broadcastFn) {
  _broadcastFn = broadcastFn;
  if (_analysisTimer) clearInterval(_analysisTimer);
  _analysisTimer = setInterval(async () => {
    try { await runAnalysis(); } catch (e) { console.error('[AI-Trader]', e.message); }
  }, ANALYSIS_MS);
  console.log('[AI-Trader] Agente iniciado — analisis cada 5 min');
}

module.exports = { init, runAnalysis, getConfig, updateConfig, getRecentSignals };