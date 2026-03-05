// src/services/ai-trader.js
// Agente de IA — analiza mercado por sector + noticias + genera/ejecuta señales

const { getDB }          = require('../models/db');
const { getOpenAIToken } = require('./ai-token');
const cocos              = require('./cocos');
const market             = require('./market-monitor');
const news               = require('./news-fetcher');

const ANALYSIS_MS  = 5 * 60 * 1000;
const OPENAI_MODEL = 'gpt-4o-mini';

const SECTORS = {
  'Energía/Petróleo': ['YPFD', 'PAMP', 'TGNO4', 'TGSU2', 'CEPU', 'XOM', 'CVX'],
  'Bancos/Finanzas':  ['GGAL', 'BBAR', 'BMA', 'SUPV'],
  'Materiales':       ['ALUA', 'LOMA', 'TXAR'],
  'Tech Global':      ['AAPL', 'MSFT', 'GOOGL', 'NVDA', 'META', 'AMZN', 'TSLA'],
  'Latam/Otros':      ['MELI', 'TECO2'],
};

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
  const fields = Object.keys(changes).map(k => `${k} = ?`).join(', ');
  getDB().prepare(`UPDATE ai_config SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...Object.values(changes), 1);
  return getConfig();
}

// ── Señales ───────────────────────────────────────────────────────────────────

function saveSignal(signal) {
  return getDB().prepare(`
    INSERT INTO ai_signals (ticker, action, confidence, price, quantity, reason, analysis)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(signal.ticker, signal.action, signal.confidence, signal.price || 0,
         signal.quantity || 0, signal.reason || '', signal.analysis || '');
}

function getRecentSignals(limit) {
  return getDB().prepare('SELECT * FROM ai_signals ORDER BY created_at DESC LIMIT ?').all(limit || 20);
}

function markSignalExecuted(id, orderId) {
  getDB().prepare('UPDATE ai_signals SET executed = 1, order_id = ? WHERE id = ?').run(orderId || '', id);
}

// ── Contexto de mercado por sector ───────────────────────────────────────────

function buildSectorContext() {
  const lines = [];
  for (const [sector, tickers] of Object.entries(SECTORS)) {
    const sectorData = [];
    for (const ticker of tickers) {
      const ind = market.getIndicators(ticker);
      if (!ind || ind.price <= 0 || ind.dataPoints < 2) continue;
      const latest = market.getLatestPrice(ticker);
      const v = latest?.variation || 0;
      sectorData.push(
        `  ${ticker}: $${ind.price.toFixed(2)} | Var:${v >= 0 ? '+' : ''}${v.toFixed(1)}% | ` +
        `Tend5p:${ind.trend5}% | RSI:${ind.rsi ?? 'N/D'} | ` +
        `SMA20:${ind.sma20 ? '$' + ind.sma20.toFixed(0) : 'N/D'} | ` +
        `SMA50:${ind.sma50 ? '$' + ind.sma50.toFixed(0) : 'N/D'}`
      );
    }
    if (sectorData.length > 0) {
      lines.push(`SECTOR ${sector}:`);
      lines.push(...sectorData);
    }
  }
  return lines.length > 0 ? lines.join('\n') : 'Mercado cerrado o sin datos suficientes aún.';
}

// ── Contexto de noticias ──────────────────────────────────────────────────────

function buildNewsContext(tickers) {
  const items = news.getNewsForTickers(tickers, 10);
  if (!items.length) return 'Sin noticias recientes disponibles.';
  return items.map(n =>
    `[${n.source}] ${n.title}`
  ).join('\n');
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

async function callOpenAI(prompt) {
  const apiKey = await getOpenAIToken();
  if (!apiKey) throw new Error('Sin token OpenAI');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.25,
      max_tokens: 2000,
      messages: [
        {
          role: 'system',
          content: `Eres un agente de trading experto en el mercado de capitales argentino (BYMA/Merval) y en CEDEARs.
Analizas datos técnicos, noticias y contexto macroeconómico para generar señales precisas de trading.
Conoces los sectores: Energía (YPF, PAMP, gaseoductos), Bancos (Galicia, BBVA, Macro), Materiales (Aluar, Loma Negra, Ternium), Tech global (Apple, Microsoft, Nvidia, etc.) y CEDEARs.
SIEMPRE respondes en JSON válido. Eres conservador: priorizás no perder capital. Usás stop-loss implícito en tus recomendaciones.
Considerás el contexto macro argentino: dólar, inflación, reservas del BCRA, estabilidad política.`,
        },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(`OpenAI ${res.status}: ${e.error?.message || 'error'}`); }
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

// ── Análisis principal ────────────────────────────────────────────────────────

async function runAnalysis() {
  const cfg = getConfig();
  if (!cfg.enabled) return null;
  if (!cocos.isReady()) return null;

  console.log('[AI-Trader] Iniciando análisis sectorial...');

  const marketCtx = buildSectorContext();
  const allTickers = Object.values(SECTORS).flat();
  const newsCtx   = buildNewsContext(allTickers);

  let portfolio = 'Sin posiciones abiertas';
  let buyingPower = 'Sin datos';
  let marketOpen = false;

  try {
    const bp = await cocos.getBuyingPower();
    const arsDisp = bp?.['24hs']?.ars || bp?.CI?.ars || 0;
    const usdDisp = bp?.['24hs']?.usd || bp?.CI?.usd || 0;
    buyingPower = `ARS $${arsDisp.toLocaleString()} | USD $${usdDisp.toFixed(2)}`;
  } catch {}

  try {
    const port = await cocos.getPortfolio();
    if (port?.positions?.length > 0) {
      portfolio = port.positions.map(p =>
        `${p.ticker || p.instrument_code}: ${p.quantity} uds @ $${p.last_price}`
      ).join(' | ');
    }
  } catch {}

  try {
    const ms = await cocos.getMarketStatus();
    marketOpen = !!(ms?.['24hs'] || ms?.CI);
  } catch {}

  const prompt = `
Realiza un análisis completo del mercado argentino y genera señales de trading por sector.

ESTADO DEL MERCADO: ${marketOpen ? 'ABIERTO ✅' : 'CERRADO ⏸ (prepará señales para apertura)'}
PODER DE COMPRA: ${buyingPower}
CARTERA ACTUAL: ${portfolio}
MÁX POR OPERACIÓN: ARS $${cfg.max_per_trade_ars}

═══════════════════════════════════
DATOS TÉCNICOS POR SECTOR
═══════════════════════════════════
${marketCtx}

═══════════════════════════════════
NOTICIAS FINANCIERAS RECIENTES
═══════════════════════════════════
${newsCtx}

═══════════════════════════════════
REGLAS DE ANÁLISIS
═══════════════════════════════════
1. RSI > 70 = sobrecomprado → considerar VENTA
2. RSI < 30 = sobrevendido → considerar COMPRA
3. Precio > SMA20 y SMA20 > SMA50 = tendencia alcista → COMPRA
4. Precio < SMA20 y SMA20 < SMA50 = tendencia bajista → VENTA
5. Tendencia 5p > 3% con RSI 40-65 = momentum alcista → COMPRA
6. Considerar contexto macroeconómico argentino
7. CEDEARs: analizar también contexto internacional del sector
8. Priorizar sectores: Energía y Bancos argentinos (más líquidos), Tech global (CEDEARs seguros)
9. quantity debe ser entero ≥ 1, precio en ARS
10. Solo señales con datos suficientes (≥5 datapoints)

Responde SOLO con este JSON:
{
  "signals": [
    {
      "ticker": "YPFD",
      "sector": "Energía/Petróleo",
      "action": "BUY",
      "confidence": 0.82,
      "price": 24500,
      "quantity": 2,
      "reason": "Explicación técnica + contexto noticia si aplica"
    }
  ],
  "sector_analysis": {
    "Energía/Petróleo": "análisis breve",
    "Bancos/Finanzas": "análisis breve",
    "Tech Global": "análisis breve"
  },
  "analysis": "Resumen ejecutivo del mercado en 2-3 oraciones",
  "market_sentiment": "BULLISH|BEARISH|NEUTRAL",
  "macro_note": "Comentario breve sobre contexto macro argentino"
}
Si no hay señales claras, signals: []`;

  let result;
  try {
    result = await callOpenAI(prompt);
  } catch (e) {
    console.error('[AI-Trader] Error OpenAI:', e.message);
    return null;
  }

  const signals = result.signals || [];
  console.log(`[AI-Trader] ${signals.length} señales | Sentimiento: ${result.market_sentiment}`);

  for (const sig of signals) {
    if (sig.confidence < cfg.min_confidence) continue;
    const saved = saveSignal({ ...sig, analysis: result.analysis });

    if (cfg.auto_execute && marketOpen && sig.price > 0 && sig.quantity > 0) {
      try {
        let orderResult;
        if (sig.action === 'BUY')  orderResult = await cocos.placeBuyOrder(sig.ticker, sig.quantity, sig.price, '24hs', 'ARS', 'C');
        if (sig.action === 'SELL') orderResult = await cocos.placeSellOrder(sig.ticker, sig.quantity, sig.price, '24hs', 'ARS', 'C');
        if (orderResult) {
          markSignalExecuted(saved.lastInsertRowid, orderResult.Orden || orderResult.id || 'OK');
          console.log(`[AI-Trader] ✅ Ejecutado: ${sig.action} ${sig.ticker} x${sig.quantity} @ $${sig.price}`);
        }
      } catch (e) {
        console.error(`[AI-Trader] Error ejecutando ${sig.ticker}:`, e.message);
      }
    }
  }

  if (_broadcastFn) _broadcastFn({ type: 'ai_analysis', data: result, timestamp: new Date().toISOString() });
  return result;
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init(broadcastFn) {
  _broadcastFn = broadcastFn;
  if (_analysisTimer) clearInterval(_analysisTimer);
  _analysisTimer = setInterval(async () => {
    try { await runAnalysis(); } catch (e) { console.error('[AI-Trader]', e.message); }
  }, ANALYSIS_MS);
  console.log('[AI-Trader] Agente sectorial iniciado — análisis cada 5 min');
}

module.exports = { init, runAnalysis, getConfig, updateConfig, getRecentSignals };