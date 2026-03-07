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
  'Energia/Petroleo': ['YPFD', 'PAMP', 'TGNO4', 'TGSU2', 'CEPU', 'XOM', 'CVX', 'OXY', 'VIST', 'XLE'],
  'Bancos/Finanzas':  ['GGAL', 'BBAR', 'BMA', 'SUPV'],
  'Materiales':       ['ALUA', 'LOMA', 'TXAR'],
  'Tech Global':      ['AAPL', 'MSFT', 'GOOGL', 'NVDA', 'META', 'AMZN', 'TSLA', 'AMD', 'SMCI', 'PLTR'],
  'ETF':              ['SPY', 'QQQ', 'SMH', 'GLD'],
  'Latam/Otros':      ['MELI', 'TECO2', 'GLOB'],
};

const CEDEARS  = new Set(['AAPL','MSFT','GOOGL','NVDA','META','AMZN','TSLA','XOM','CVX','MELI','OXY','VIST','XLE','SMCI','PLTR','SPY','QQQ','SMH','GLD','AMD']);
const ACCIONES = new Set(['YPFD','PAMP','TGNO4','TGSU2','CEPU','GGAL','BBAR','BMA','SUPV','ALUA','LOMA','TXAR','TECO2']);

let _analysisTimer = null;
let _broadcastFn   = null;

// Horario real operatoria Cocos Capital / BYMA: 10:30 a 17:00 ART, lunes a viernes
function isMarketHours() {
  const now = new Date();
  const utc  = now.getTime() + now.getTimezoneOffset() * 60000;
  const art  = new Date(utc - 3 * 3600000);
  const day  = art.getDay();
  const hhmm = art.getHours() * 100 + art.getMinutes();
  if (day === 0 || day === 6) return false;
  return hhmm >= 1030 && hhmm < 1700;
}

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
      model: OPENAI_MODEL, temperature: 0.25, max_tokens: 1200,
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

  // No gastar OpenAI en fin de semana ni fuera de horario
  if (!isMarketHours()) {
    console.log('[AI-Trader] Mercado cerrado — skip análisis (ahorro OpenAI)');
    return null;
  }

  console.log('[AI-Trader] Iniciando analisis...');

  const tickers   = getActiveTickers(cfg);
  const marketCtx = buildMarketContext(tickers);
  const newsItems = cfg.news_driven !== 0 ? news.getNewsForTickers(tickers, 15) : [];
  const newsCtx   = newsItems.length ? newsItems.map(n => `[${n.source}] ${n.title}`).join('\n') : 'Sin noticias recientes.';
  const ragCtx    = cfg.use_rag !== 0 ? await rag.buildRAGContext('mercado argentino acciones cedear inversion ' + tickers.join(' '), false) : '';

  let portfolio = 'Sin posiciones', buyingPower = 'Sin datos', marketOpen = false;
  try { const bp = await cocos.getBuyingPower(); buyingPower = `ARS $${(bp?.['24hs']?.ars||0).toLocaleString()} | USD $${(bp?.['24hs']?.usd||0).toFixed(2)}`; } catch {}
  try { const p = await cocos.getPortfolio(); if (p?.positions?.length) portfolio = p.positions.map(x => `${x.ticker||x.instrument_code}: ${x.quantity}uds`).join(' | '); } catch {}
  try { const ms = await cocos.getMarketStatus(); marketOpen = !!(ms?.['24hs']||ms?.CI); } catch {}
  if (!marketOpen) marketOpen = isMarketHours();

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

    // Si la IA no calculó precio o cantidad, obtenerlos de Cocos
    if (!sig.price || sig.price <= 0) {
      try {
        const q = await cocos.getQuote(sig.ticker, 'C');
        sig.price = q?.last_price || q?.close_price || 0;
      } catch {}
    }
    if ((!sig.quantity || sig.quantity <= 0) && sig.price > 0 && sig.action === 'BUY') {
      sig.quantity = Math.max(1, Math.floor((cfg.max_per_trade_ars || 50000) / sig.price));
    }

    const saved = saveSignal({ ...sig, analysis: result.analysis });

    if (cfg.auto_execute && marketOpen && sig.price > 0 && sig.quantity > 0) {
      try {
        let ord;
        if (sig.action==='BUY')  ord = await cocos.placeBuyOrder(sig.ticker, sig.quantity, sig.price, '24hs', 'ARS', 'C');
        if (sig.action==='SELL') ord = await cocos.placeSellOrder(sig.ticker, sig.quantity, sig.price, '24hs', 'ARS', 'C');
        if (ord) { markSignalExecuted(saved.lastInsertRowid, ord.Orden||ord.id||'OK'); console.log(`[AI-Trader] ✅ Ejecutado: ${sig.action} ${sig.ticker} x${sig.quantity} @ $${sig.price}`); }
      } catch (e) { console.error(`[AI-Trader] Error ejecutando ${sig.ticker}:`, e.message); }
    } else if (cfg.auto_execute && !marketOpen) {
      console.log(`[AI-Trader] Señal guardada (mercado cerrado): ${sig.action} ${sig.ticker} conf:${(sig.confidence*100).toFixed(0)}%`);
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

// ── Análisis individual por ticker ────────────────────────────────────────────

async function runTickerAnalysis(ticker) {
  if (!ticker) throw new Error('Ticker requerido');
  const upperTicker = ticker.toUpperCase();
  console.log(`[AI-Trader] Análisis individual: ${upperTicker}`);

  // 1. Datos técnicos del ticker
  const ind     = market.getIndicators(upperTicker);
  const latest  = market.getLatestPrice(upperTicker);
  let quoteData = '';
  if (ind && ind.price > 0) {
    const v = latest?.variation || 0;
    quoteData = `Precio: $${ind.price.toFixed(2)} | Var: ${v>=0?'+':''}${v.toFixed(2)}% | RSI: ${ind.rsi??'N/D'} | SMA20: ${ind.sma20?'$'+ind.sma20.toFixed(0):'N/D'} | SMA50: ${ind.sma50?'$'+ind.sma50.toFixed(0):'N/D'} | Tend5: ${ind.trend5}% | DataPoints: ${ind.dataPoints}`;
  }

  // 2. Si no hay datos locales, intentar obtener de Cocos directo
  let livePrice = ind?.price || 0;
  if (!quoteData || livePrice <= 0) {
    try {
      const quote = await cocos.getQuote(upperTicker, 'C');
      livePrice = quote?.last_price || quote?.close_price || quote?.previous_close_price || 0;
      const liveVar = quote?.variation || quote?.daily_variation || 0;
      if (livePrice > 0) {
        quoteData = `Precio actual: $${livePrice.toFixed(2)} | Var: ${liveVar>=0?'+':''}${(liveVar*100).toFixed(2)}% (datos en vivo de Cocos)`;
      }
    } catch {}
  }
  if (!quoteData) quoteData = 'Sin datos de precio disponibles (mercado posiblemente cerrado).';

  // 3. Noticias específicas del ticker
  const newsItems = news.getNewsForTickers([upperTicker], 10);
  const newsCtx   = newsItems.length
    ? newsItems.map(n => `- [${n.source}] ${n.title}`).join('\n')
    : 'Sin noticias recientes para este instrumento.';

  // 4. RAG (keywords, sin embedding = gratis)
  const ragCtx = await rag.buildRAGContext(`${upperTicker} inversion rendimiento riesgo acciones cedear`, false);

  // 5. Contexto de mercado general (otros tickers para comparar)
  const allTickers = Object.values(ALL_SECTORS).flat();
  const marketLines = [];
  for (const t of allTickers.slice(0, 10)) {
    const ti = market.getIndicators(t);
    if (ti && ti.price > 0) {
      marketLines.push(`  ${t}: $${ti.price.toFixed(0)} RSI:${ti.rsi??'-'} Tend5:${ti.trend5}%`);
    }
  }

  // 6. Config
  const cfg = getConfig();

  const prompt = `ANÁLISIS INDIVIDUAL DE INVERSIÓN — ${upperTicker}

Eres un analista financiero experto. Debes analizar ESPECÍFICAMENTE el instrumento ${upperTicker} y dar una recomendación CLARA: BUY, SELL o HOLD.

DATOS DEL INSTRUMENTO ${upperTicker}:
${quoteData}

NOTICIAS RELEVANTES PARA ${upperTicker}:
${newsCtx}

CONTEXTO GENERAL DEL MERCADO (referencia):
${marketLines.join('\n') || 'Sin datos de otros instrumentos.'}
${ragCtx ? `\nCONOCIMIENTO DEL USUARIO:\n${ragCtx}` : ''}

CONFIGURACIÓN: Max/operación: ARS $${cfg.max_per_trade_ars} | Riesgo: ${cfg.risk_level} | Stop-loss: ${cfg.stop_loss_pct||5}%

INSTRUCCIONES:
1. Analiza ESPECÍFICAMENTE ${upperTicker} — NO ignores este ticker
2. Evalúa: tendencia de precio, RSI, noticias, sector, contexto macro
3. Si no hay datos técnicos suficientes, basa tu análisis en noticias y conocimiento general del activo
4. Da una recomendación CLARA: BUY, SELL o HOLD
5. Explica el por qué en 2-3 oraciones claras
6. Si recomiendas BUY: sugiere precio y cantidad (quantity = floor(max_trade / precio))
7. Sé específico y directo, NO digas "sin datos suficientes" — analiza con lo que hay

RESPONDE SOLO JSON:
{
  "ticker": "${upperTicker}",
  "action": "BUY|SELL|HOLD",
  "confidence": 0.75,
  "price": 0,
  "quantity": 0,
  "reason": "Explicación clara de por qué esta recomendación",
  "analysis": "Análisis detallado de 2-3 oraciones sobre ${upperTicker}",
  "sector_outlook": "Perspectiva del sector",
  "risk_level": "LOW|MEDIUM|HIGH",
  "news_impact": "Impacto de noticias en la decisión"
}`;

  const result = await callOpenAI(prompt);

  // Guardar señal
  if (result.ticker && result.action) {
    saveSignal({
      ticker: result.ticker, action: result.action,
      confidence: result.confidence || 0.5,
      price: result.price || livePrice,
      quantity: result.quantity || 0,
      reason: result.reason || '',
      analysis: result.analysis || '',
    });
  }

  console.log(`[AI-Trader] ${upperTicker}: ${result.action} (${((result.confidence||0)*100).toFixed(0)}%)`);
  return result;
}

module.exports = { init, runAnalysis, runTickerAnalysis, getConfig, updateConfig, getRecentSignals };