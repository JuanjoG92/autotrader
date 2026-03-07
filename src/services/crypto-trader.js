// src/services/crypto-trader.js
// AI Crypto Trader — Binance 24/7, 100% separado de Cocos
// Usa: binance.js (órdenes), news-fetcher (noticias), ai-token (OpenAI), rag (contexto)

const { getDB }          = require('../models/db');
const { getOpenAIToken } = require('./ai-token');
const { getBalances, getTicker, getTopPairs, createOrder, getExchangeForUser } = require('./binance');
const news               = require('./news-fetcher');
const rag                = require('./rag');

const OPENAI_MODEL = 'gpt-4o-mini';

const TOP_CRYPTOS = [
  'BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'SOL/USDT', 'XRP/USDT',
  'ADA/USDT', 'DOGE/USDT', 'AVAX/USDT', 'LINK/USDT', 'DOT/USDT',
];

let _timer = null;
let _monitorTimer = null;
let _broadcastFn = null;

// ── Config DB ─────────────────────────────────────────────────────────────────

function getConfig() {
  const db = getDB();
  let cfg = db.prepare('SELECT * FROM crypto_config WHERE id = 1').get();
  if (!cfg) {
    db.prepare('INSERT INTO crypto_config (id) VALUES (1)').run();
    cfg = db.prepare('SELECT * FROM crypto_config WHERE id = 1').get();
  }
  return cfg;
}

function updateConfig(changes) {
  const db = getDB();
  const fields = Object.keys(changes).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE crypto_config SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`)
    .run(...Object.values(changes));
  return getConfig();
}

// ── Posiciones DB ─────────────────────────────────────────────────────────────

function savePosition(pos) {
  return getDB().prepare(`
    INSERT INTO crypto_positions (symbol, side, quantity, entry_price, stop_loss, take_profit, status, order_id, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(pos.symbol, pos.side || 'BUY', pos.quantity, pos.entry_price,
         pos.stop_loss || 0, pos.take_profit || 0, pos.status || 'OPEN',
         pos.order_id || '', pos.reason || '');
}

function getOpenPositions() {
  return getDB().prepare("SELECT * FROM crypto_positions WHERE status = 'OPEN' ORDER BY created_at DESC").all();
}

function closePosition(id, pnl, reason) {
  getDB().prepare(
    "UPDATE crypto_positions SET status = 'CLOSED', pnl = ?, reason = reason || ' | ' || ?, closed_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(pnl || 0, reason || 'Cerrada', id);
}

function getPositionHistory(limit) {
  return getDB().prepare('SELECT * FROM crypto_positions ORDER BY created_at DESC LIMIT ?').all(limit || 30);
}

// ── Datos de mercado ──────────────────────────────────────────────────────────

async function getMarketData() {
  const rows = [];
  for (const pair of TOP_CRYPTOS) {
    try {
      const t = await getTicker(pair);
      if (t && t.last > 0) {
        rows.push(`${pair}: $${t.last.toFixed(2)} | 24h: ${t.percentage >= 0 ? '+' : ''}${t.percentage.toFixed(1)}% | Vol: $${Math.round(t.quoteVolume / 1e6)}M`);
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300)); // rate limit CoinGecko
  }
  return rows.join('\n') || 'Sin datos de mercado.';
}

// ── Binance helpers ───────────────────────────────────────────────────────────

function _getApiKeyInfo(cfg) {
  const db = getDB();
  if (cfg.api_key_id > 0) {
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(cfg.api_key_id);
    if (row) return row;
  }
  // Buscar primera API key de Binance disponible
  const row = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
  return row || null;
}

async function _executeTrade(cfg, symbol, side, quantityUSD) {
  const ticker = await getTicker(symbol);
  const price = ticker?.last || 0;
  if (price <= 0) throw new Error(`Sin precio para ${symbol}`);

  const quantity = parseFloat((quantityUSD / price).toFixed(6));
  if (quantity <= 0) throw new Error(`Cantidad muy baja para ${symbol}`);

  // Intentar ejecutar en Binance si hay API key y funciona
  const keyInfo = _getApiKeyInfo(cfg);
  let order = null;
  let mode = 'PAPER';

  if (keyInfo) {
    try {
      order = await createOrder(keyInfo.user_id, keyInfo.id, symbol, side.toLowerCase(), quantity);
      mode = 'LIVE';
    } catch (e) {
      console.warn(`[Crypto] Binance no disponible (${e.message.substring(0, 60)}) — ejecutando en modo paper`);
    }
  }

  console.log(`[Crypto] ${mode} ${side} ${symbol}: ${quantity} @ $${price} (~$${quantityUSD})`);
  return { order: order || { id: 'PAPER-' + Date.now() }, price, quantity, mode };
}

// ── AI Análisis ───────────────────────────────────────────────────────────────

async function runAnalysis() {
  const cfg = getConfig();
  if (!cfg.enabled) return null;

  const apiKey = await getOpenAIToken();
  if (!apiKey) { console.warn('[Crypto] Sin token OpenAI'); return null; }

  console.log('[Crypto] Iniciando análisis...');

  // Datos de mercado
  const marketCtx = await getMarketData();

  // Noticias crypto
  const cryptoTickers = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'CRYPTO'];
  const newsItems = news.getNewsForTickers(cryptoTickers, 15);
  const newsCtx = newsItems.length
    ? newsItems.map(n => `[${n.source}] ${n.title}`).join('\n')
    : 'Sin noticias crypto recientes.';

  // RAG
  const ragCtx = await rag.buildRAGContext('bitcoin ethereum crypto trading strategy risk');

  // Posiciones abiertas
  const positions = getOpenPositions();
  const posCtx = positions.length
    ? positions.map(p => `${p.symbol}: ${p.quantity} @ $${p.entry_price} (SL:$${p.stop_loss} TP:$${p.take_profit})`).join('\n')
    : 'Sin posiciones abiertas.';

  // Balance (intentar Binance, sino simular)
  let balanceCtx = `USDT libre: $${cfg.max_per_trade_usd * 10} (paper trading)`;
  try {
    const keyInfo = _getApiKeyInfo(cfg);
    if (keyInfo) {
      const bal = await getBalances(keyInfo.user_id, keyInfo.id);
      const usdtBal = bal.USDT?.free || 0;
      const entries = Object.entries(bal).filter(([k, v]) => v.total > 0 && k !== 'USDT').slice(0, 5);
      balanceCtx = `USDT libre: $${usdtBal.toFixed(2)}`;
      if (entries.length) balanceCtx += ' | ' + entries.map(([k, v]) => `${k}: ${v.total}`).join(', ');
    }
  } catch { /* usar balance paper */ }

  const prompt = `ANÁLISIS CRYPTO TRADING — Binance Spot 24/7

MERCADO CRYPTO ACTUAL:
${marketCtx}

BALANCE: ${balanceCtx}
MAX POR OPERACIÓN: $${cfg.max_per_trade_usd} USD | RIESGO: ${cfg.risk_level}
STOP-LOSS: ${cfg.stop_loss_pct}% | TAKE-PROFIT: ${cfg.take_profit_pct}%

POSICIONES ABIERTAS:
${posCtx}

NOTICIAS CRYPTO:
${newsCtx}
${ragCtx ? `\nCONTEXTO ADICIONAL:\n${ragCtx}` : ''}

REGLAS:
1. DEBES generar entre 1 y 3 señales SIEMPRE — nunca 0 señales
2. Solo pares /USDT en Binance Spot: BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, LINK, DOT
3. Ser inteligente: comprar en caídas con fundamentos, vender en picos
4. Si hay posiciones abiertas que deberían cerrarse, señalar SELL
5. Confidence entre 0.65 y 0.95
6. Considerar tendencia 24h, volumen, noticias
7. No comprar lo que ya tenemos abierto
8. En mercado bajista: buscar oportunidades de compra en sobreventa
9. En mercado alcista: tomar ganancias parciales

RESPONDE SOLO JSON:
{
  "signals": [{"symbol":"BTC/USDT","action":"BUY","confidence":0.82,"reason":"Tendencia alcista + volumen creciente"}],
  "analysis": "Resumen ejecutivo breve",
  "market_sentiment": "BULLISH|BEARISH|NEUTRAL"
}`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: OPENAI_MODEL, temperature: 0.2, max_tokens: 1500,
        messages: [
          { role: 'system', content: 'Eres un trader de criptomonedas experto. Analizas mercado + noticias para generar señales de trading. Conservador. JSON válido siempre.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) { console.error('[Crypto] OpenAI error:', res.status); return null; }
    const result = JSON.parse((await res.json()).choices[0].message.content);

    console.log(`[Crypto] ${(result.signals||[]).length} señales | ${result.market_sentiment} | ${result.analysis?.substring(0, 80)}`);

    // Ejecutar señales
    for (const sig of (result.signals || [])) {
      if (!sig.symbol || (sig.confidence || 0) < cfg.min_confidence) continue;

      // No comprar si ya tenemos posición abierta
      if (sig.action === 'BUY' && positions.some(p => p.symbol === sig.symbol)) {
        console.log(`[Crypto] Skip ${sig.symbol} — ya tenemos posición abierta`);
        continue;
      }

      try {
        if (sig.action === 'BUY') {
          const { order, price, quantity } = await _executeTrade(cfg, sig.symbol, 'buy', cfg.max_per_trade_usd);
          const sl = Math.round(price * (1 - cfg.stop_loss_pct / 100) * 100) / 100;
          const tp = Math.round(price * (1 + cfg.take_profit_pct / 100) * 100) / 100;
          savePosition({
            symbol: sig.symbol, side: 'BUY', quantity, entry_price: price,
            stop_loss: sl, take_profit: tp, status: 'OPEN',
            order_id: order?.id || '', reason: sig.reason,
          });
          console.log(`[Crypto] ✅ BUY ${sig.symbol}: ${quantity} @ $${price} | SL:$${sl} TP:$${tp}`);
        }

        if (sig.action === 'SELL') {
          const pos = positions.find(p => p.symbol === sig.symbol);
          if (pos) {
            await _executeSellPosition(cfg, pos, sig.reason);
          }
        }
      } catch (e) {
        console.error(`[Crypto] Error ${sig.action} ${sig.symbol}:`, e.message);
      }
    }

    if (_broadcastFn) _broadcastFn({ type: 'crypto_analysis', data: result, timestamp: new Date().toISOString() });
    return result;
  } catch (e) {
    console.error('[Crypto] Error análisis:', e.message);
    return null;
  }
}

// ── Monitor de posiciones ─────────────────────────────────────────────────────

async function monitorPositions() {
  const cfg = getConfig();
  if (!cfg.enabled) return;

  const positions = getOpenPositions();
  if (!positions.length) return;

  for (const pos of positions) {
    try {
      const ticker = await getTicker(pos.symbol);
      const price = ticker?.last || 0;
      if (price <= 0) continue;

      // Actualizar precio actual
      getDB().prepare('UPDATE crypto_positions SET current_price = ? WHERE id = ?').run(price, pos.id);

      const pnlPct = ((price - pos.entry_price) / pos.entry_price) * 100;

      // Stop-Loss
      if (pos.stop_loss > 0 && price <= pos.stop_loss) {
        console.log(`[Crypto] 🛑 STOP-LOSS ${pos.symbol}: $${price} <= $${pos.stop_loss} (${pnlPct.toFixed(1)}%)`);
        await _executeSellPosition(cfg, pos, `Stop-loss: ${pnlPct.toFixed(1)}%`);
        continue;
      }

      // Take-Profit
      if (pos.take_profit > 0 && price >= pos.take_profit) {
        console.log(`[Crypto] 🎉 TAKE-PROFIT ${pos.symbol}: $${price} >= $${pos.take_profit} (+${pnlPct.toFixed(1)}%)`);
        await _executeSellPosition(cfg, pos, `Take-profit: +${pnlPct.toFixed(1)}%`);
        continue;
      }

      // Trailing stop: si ganó > 4%, subir SL a entry +1%
      if (pnlPct > 4 && pos.stop_loss < pos.entry_price) {
        const newSL = Math.round(pos.entry_price * 1.01 * 100) / 100;
        getDB().prepare('UPDATE crypto_positions SET stop_loss = ? WHERE id = ?').run(newSL, pos.id);
        console.log(`[Crypto] 📊 Trailing ${pos.symbol}: SL → $${newSL}`);
      }

      await new Promise(r => setTimeout(r, 300));
    } catch {}
  }
}

async function _executeSellPosition(cfg, pos, reason) {
  try {
    const ticker = await getTicker(pos.symbol);
    const price = ticker?.last || pos.current_price || pos.entry_price;
    const pnl = (price - pos.entry_price) * pos.quantity;

    const keyInfo = _getApiKeyInfo(cfg);
    if (keyInfo) {
      await createOrder(keyInfo.user_id, keyInfo.id, pos.symbol, 'sell', pos.quantity);
    }

    closePosition(pos.id, pnl, reason);
    console.log(`[Crypto] 💰 SELL ${pos.symbol} x${pos.quantity} @ $${price} | PnL: $${pnl.toFixed(2)} | ${reason}`);

    if (_broadcastFn) _broadcastFn({
      type: 'crypto_sell', symbol: pos.symbol, quantity: pos.quantity,
      entry: pos.entry_price, exit: price, pnl, reason,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`[Crypto] Error vendiendo ${pos.symbol}:`, e.message);
  }
}

// ── Init / Control ────────────────────────────────────────────────────────────

function init(broadcastFn) {
  _broadcastFn = broadcastFn;
  const cfg = getConfig();
  const intervalMs = (cfg.analysis_interval_min || 3) * 60 * 1000;

  if (_timer) clearInterval(_timer);
  if (_monitorTimer) clearInterval(_monitorTimer);

  _timer = setInterval(async () => {
    try { await runAnalysis(); } catch (e) { console.error('[Crypto]', e.message); }
  }, intervalMs);

  _monitorTimer = setInterval(async () => {
    try { await monitorPositions(); } catch (e) { console.error('[Crypto] Monitor:', e.message); }
  }, 30 * 1000);

  console.log(`[Crypto] AI Trader iniciado — análisis cada ${cfg.analysis_interval_min || 3} min, monitor cada 30s`);

  // Primer análisis tras 20s
  setTimeout(async () => {
    try { await runAnalysis(); } catch (e) { console.error('[Crypto] Inicial:', e.message); }
  }, 20000);
}

function getStatus() {
  const cfg = getConfig();
  const positions = getOpenPositions();
  return {
    enabled: !!cfg.enabled,
    openPositions: positions.length,
    positions: positions.map(p => ({
      symbol: p.symbol, qty: p.quantity, entry: p.entry_price,
      current: p.current_price, sl: p.stop_loss, tp: p.take_profit,
      pnlPct: p.current_price ? (((p.current_price - p.entry_price) / p.entry_price) * 100).toFixed(1) + '%' : 'N/A',
    })),
    config: { max_usd: cfg.max_per_trade_usd, risk: cfg.risk_level, sl: cfg.stop_loss_pct, tp: cfg.take_profit_pct },
  };
}

module.exports = {
  init, getConfig, updateConfig, runAnalysis, monitorPositions,
  getStatus, getOpenPositions, getPositionHistory,
};
