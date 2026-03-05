// src/services/ai-trader.js
// Agente de IA — analiza mercado y genera/ejecuta señales de trading

const { getDB }       = require('../models/db');
const { getOpenAIToken } = require('./ai-token');
const cocos           = require('./cocos');
const market          = require('./market-monitor');

const ANALYSIS_MS     = 5 * 60 * 1000;  // cada 5 minutos
const OPENAI_MODEL    = 'gpt-4o-mini';

let _analysisTimer = null;
let _broadcastFn   = null;

// ── Config desde DB ───────────────────────────────────────────────────────────

function getConfig() {
  const db  = getDB();
  let cfg = db.prepare('SELECT * FROM ai_config WHERE id = 1').get();
  if (!cfg) {
    db.prepare(`INSERT INTO ai_config (id) VALUES (1)`).run();
    cfg = db.prepare('SELECT * FROM ai_config WHERE id = 1').get();
  }
  return cfg;
}

function updateConfig(changes) {
  const fields = Object.keys(changes).map(k => `${k} = ?`).join(', ');
  const vals   = [...Object.values(changes), 1];
  getDB().prepare(`UPDATE ai_config SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals);
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
  return getDB().prepare(
    'SELECT * FROM ai_signals ORDER BY created_at DESC LIMIT ?'
  ).all(limit || 20);
}

function markSignalExecuted(id, orderId) {
  getDB().prepare('UPDATE ai_signals SET executed = 1, order_id = ? WHERE id = ?').run(orderId || '', id);
}

// ── Contexto de mercado ───────────────────────────────────────────────────────

function buildMarketContext() {
  const watchlist = market.getActiveWatchlist();
  const lines     = [];

  for (const item of watchlist) {
    const ind = market.getIndicators(item.ticker);
    if (!ind || ind.price <= 0) continue;

    const latest  = market.getLatestPrice(item.ticker);
    const varSign = (latest?.variation || 0) >= 0 ? '+' : '';

    lines.push(
      `${item.ticker}: Precio $${ind.price.toFixed(2)} | ` +
      `Var ${varSign}${(latest?.variation || 0).toFixed(2)}% | ` +
      `Tendencia 5p: ${ind.trend5}% | ` +
      `RSI: ${ind.rsi ?? 'N/D'} | ` +
      `SMA20: ${ind.sma20 ? '$' + ind.sma20.toFixed(2) : 'N/D'} | ` +
      `SMA50: ${ind.sma50 ? '$' + ind.sma50.toFixed(2) : 'N/D'} | ` +
      `Datos: ${ind.dataPoints} registros`
    );
  }
  return lines.length > 0 ? lines.join('\n') : 'Sin datos de mercado disponibles';
}

// ── Llamada a OpenAI ──────────────────────────────────────────────────────────

async function callOpenAI(prompt) {
  const apiKey = await getOpenAIToken();
  if (!apiKey) throw new Error('Sin token OpenAI');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.3,
      max_tokens: 1500,
      messages: [
        {
          role: 'system',
          content: `Eres un agente de trading experto en el mercado de capitales argentino (BYMA).
Analizas datos técnicos y fundamentales para generar señales de compra/venta.
SIEMPRE respondes en JSON válido con el formato exacto solicitado.
Eres conservador: solo recomiendas cuando hay señales claras. Priorizas no perder capital.
Conoces los CEDEARs (acciones extranjeras que cotizan en Argentina en pesos).`,
        },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`OpenAI ${res.status}: ${err.error?.message || 'error'}`);
  }

  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

// ── Análisis principal ────────────────────────────────────────────────────────

async function runAnalysis() {
  const cfg = getConfig();
  if (!cfg.enabled) return null;
  if (!cocos.isReady()) return null;

  console.log('[AI-Trader] Iniciando análisis...');

  // Contexto de mercado
  const marketCtx = buildMarketContext();

  // Portfolio y poder de compra
  let portfolio   = 'Sin datos';
  let buyingPower = 'Sin datos';
  try {
    const bp  = await cocos.getBuyingPower();
    buyingPower = `ARS disponible: $${bp?.['24hs']?.ars?.toFixed(2) || 0} | USD: $${bp?.['24hs']?.usd?.toFixed(2) || 0}`;
    const port = await cocos.getPortfolio();
    if (port?.positions?.length > 0) {
      portfolio = port.positions.map(p =>
        `${p.ticker || p.instrument_code}: ${p.quantity} unidades, precio actual $${p.last_price}`
      ).join('\n');
    } else { portfolio = 'Cartera vacía'; }
  } catch {}

  // Estado del mercado
  let marketOpen = false;
  try { const ms = await cocos.getMarketStatus(); marketOpen = ms?.['24hs'] || ms?.CI || false; } catch {}

  const prompt = `
Analiza el mercado argentino y genera señales de trading.

ESTADO DEL MERCADO: ${marketOpen ? 'ABIERTO' : 'CERRADO (puedes preparar señales para la apertura)'}

CARTERA ACTUAL:
${portfolio}

PODER DE COMPRA:
${buyingPower}

DATOS DE MERCADO (precio actual | variación diaria | tendencia 5 períodos | RSI | SMA20 | SMA50):
${marketCtx}

CONFIGURACIÓN DE RIESGO:
- Nivel: ${cfg.risk_level}
- Máximo por operación: ARS $${cfg.max_per_trade_ars}
- Confianza mínima requerida: ${(cfg.min_confidence * 100).toFixed(0)}%

REGLAS:
1. RSI > 70 = sobrecomprado (señal de VENTA)
2. RSI < 30 = sobrevendido (señal de COMPRA)
3. Precio cruza SMA20 hacia arriba = señal de COMPRA
4. Precio cruza SMA20 hacia abajo = señal de VENTA
5. Tendencia 5p > 2% y RSI entre 40-65 = COMPRA con momentum
6. No superar el máximo por operación
7. quantity en número entero de lotes (mínimo 1)

Responde SOLO con este JSON (sin texto adicional):
{
  "signals": [
    {
      "ticker": "GGAL",
      "action": "BUY",
      "confidence": 0.82,
      "price": 2450.50,
      "quantity": 10,
      "reason": "RSI en zona de sobreventa (28), cruce SMA20 inminente, tendencia recuperación"
    }
  ],
  "analysis": "Resumen del análisis general del mercado en 2-3 oraciones",
  "market_sentiment": "BULLISH|BEARISH|NEUTRAL"
}

Si no hay señales claras, devuelve signals: []
`;

  let result;
  try {
    result = await callOpenAI(prompt);
  } catch (e) {
    console.error('[AI-Trader] Error OpenAI:', e.message);
    return null;
  }

  console.log(`[AI-Trader] Análisis OK: ${result.signals?.length || 0} señales | Sentimiento: ${result.market_sentiment}`);

  // Guardar señales
  for (const sig of (result.signals || [])) {
    if (sig.confidence < cfg.min_confidence) continue;
    const saved = saveSignal({ ...sig, analysis: result.analysis });

    // Auto-ejecutar si está activado
    if (cfg.auto_execute && marketOpen && sig.price > 0 && sig.quantity > 0) {
      try {
        let orderResult;
        if (sig.action === 'BUY') {
          orderResult = await cocos.placeBuyOrder(sig.ticker, sig.quantity, sig.price, '24hs', 'ARS', 'C');
        } else if (sig.action === 'SELL') {
          orderResult = await cocos.placeSellOrder(sig.ticker, sig.quantity, sig.price, '24hs', 'ARS', 'C');
        }
        if (orderResult) {
          markSignalExecuted(saved.lastInsertRowid, orderResult.Orden || orderResult.id || 'OK');
          console.log(`[AI-Trader] Orden ejecutada: ${sig.action} ${sig.ticker} x${sig.quantity}`);
        }
      } catch (e) {
        console.error(`[AI-Trader] Error ejecutando ${sig.ticker}:`, e.message);
      }
    }
  }

  if (_broadcastFn) {
    _broadcastFn({ type: 'ai_analysis', data: result, timestamp: new Date().toISOString() });
  }

  return result;
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init(broadcastFn) {
  _broadcastFn = broadcastFn;
  if (_analysisTimer) clearInterval(_analysisTimer);
  _analysisTimer = setInterval(async () => {
    try { await runAnalysis(); } catch (e) { console.error('[AI-Trader] Error:', e.message); }
  }, ANALYSIS_MS);
  console.log('[AI-Trader] Agente iniciado — análisis cada 5 min');
}

module.exports = {
  init,
  runAnalysis,
  getConfig,
  updateConfig,
  getRecentSignals,
};
