// src/services/volume-detector.js
// Detección de anomalías de volumen + análisis sectorial de criptos
// Método profesional: detectar pumps ANTES de que ocurran por volumen anormal

const { getTopGainers, getTicker, getOHLCV, getOrderBook } = require('./binance');

// ── Sector Watchlist ──────────────────────────────────────────────────────────
// Criptos que trackean sectores reales (tech, energía, commodities, AI)
// Estas tienden a correlacionar con acciones del sector correspondiente

const SECTOR_CRYPTOS = {
  'AI_TECH': {
    label: 'Inteligencia Artificial / Tecnología',
    pairs: ['FET/USDT', 'RNDR/USDT', 'TAO/USDT', 'ARKM/USDT', 'WLD/USDT', 'INJ/USDT', 'GRT/USDT', 'THETA/USDT'],
  },
  'ENERGY': {
    label: 'Energía / Green Energy',
    pairs: ['POWR/USDT', 'JASMY/USDT', 'IOTA/USDT', 'VET/USDT'],
  },
  'RWA': {
    label: 'Real World Assets (tokenización de activos reales)',
    pairs: ['ONDO/USDT', 'PENDLE/USDT', 'MKR/USDT', 'COMP/USDT', 'SNX/USDT'],
  },
  'DEFI_INFRA': {
    label: 'DeFi / Infraestructura (correlaciona con tech)',
    pairs: ['LINK/USDT', 'UNI/USDT', 'AAVE/USDT', 'ARB/USDT', 'OP/USDT'],
  },
  'COMMODITIES': {
    label: 'Commodities / Oro digital',
    pairs: ['PAXG/USDT'],
  },
};

function getAllSectorPairs() {
  const all = new Set();
  for (const sector of Object.values(SECTOR_CRYPTOS)) {
    for (const pair of sector.pairs) all.add(pair);
  }
  return [...all];
}

function getSectorForSymbol(symbol) {
  for (const [key, sector] of Object.entries(SECTOR_CRYPTOS)) {
    if (sector.pairs.includes(symbol)) return { key, label: sector.label };
  }
  return null;
}

// ── Filtros de liquidez ──────────────────────────────────────────────────────
const MIN_VOLUME_24H = 10_000_000; // Mínimo $10M vol diario (evitar shitcoins ilíquidas)
const MAX_PUMP_24H = 25;           // Si +25% ya fue, probablemente final de pump

// ── EMA (Exponential Moving Average) ──────────────────────────────────────────

function calculateEMA(data, period) {
  if (data.length < period) return data[data.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

// ── ATR (Average True Range) — mide volatilidad real ──────────────────────────

function calculateATR(candles, period) {
  period = period || 14;
  if (candles.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i][2];
    const low = candles[i][3];
    const prevClose = candles[i - 1][4];
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// ── Volume Spike Detection ────────────────────────────────────────────────────
// Detecta anomalías de volumen: si el volumen actual es X veces mayor que el
// promedio, indica que hay dinero entrando → posible pump inminente

async function detectVolumeSpikes(minRatio) {
  minRatio = minRatio || 3;
  const spikes = [];

  try {
    const gainers = await getTopGainers(30);
    if (!gainers || !gainers.length) return spikes;

    let skippedLiq = 0, skippedPump = 0;

    for (const coin of gainers) {
      try {
        // FILTRO 1: Liquidez — mínimo $10M volumen diario
        if (coin.volume < MIN_VOLUME_24H) { skippedLiq++; continue; }

        // FILTRO 2: Pump cap — si +25% probablemente ya es tarde
        if (coin.change24h > MAX_PUMP_24H) { skippedPump++; continue; }

        // 72 velas de 1h = 3 días de contexto (no solo 24h)
        const candles = await getOHLCV(coin.symbol, '1h', 72);
        if (!candles || candles.length < 24) continue;

        // Volumen promedio (excluyendo últimas 3 velas para detectar spike reciente)
        const volumes = candles.slice(0, -3).map(c => c[5]);
        const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
        if (avgVolume <= 0) continue;

        // Volumen de las últimas 3 velas promediado (spike reciente, no solo 1 vela)
        const recentVols = candles.slice(-3).map(c => c[5]);
        const recentAvg = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
        const spikeRatio = recentAvg / avgVolume;

        if (spikeRatio >= minRatio) {
          const closes = candles.map(c => c[4]);
          const currentPrice = closes[closes.length - 1];

          // EMA trend con más contexto (72 velas)
          const ema20 = calculateEMA(closes, 20);
          const ema50 = calculateEMA(closes, Math.min(50, closes.length));
          const trendUp = ema20 > ema50 && currentPrice > ema20;

          // Breakout: precio rompe máximo de 6h (confirmación de momentum)
          const high6h = Math.max(...candles.slice(-6).map(c => c[2]));
          const high24h = Math.max(...candles.slice(-24).map(c => c[2]));
          const breakout6h = currentPrice >= high6h * 0.995; // dentro del 0.5% del max 6h
          const dropFromHigh = ((high24h - currentPrice) / high24h) * 100;
          const nearHigh = dropFromHigh < 3;

          // ATR: volatilidad real (evitar mercados muertos)
          const atr = calculateATR(candles, 14);
          const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
          const hasVolatility = atrPct > 0.5; // al menos 0.5% de rango por vela

          const sector = getSectorForSymbol(coin.symbol);

          spikes.push({
            symbol: coin.symbol,
            price: currentPrice,
            change24h: coin.change24h || 0,
            spikeRatio: Math.round(spikeRatio * 10) / 10,
            avgVolume: Math.round(avgVolume),
            currentVolume: Math.round(recentAvg),
            volume24h: coin.volume || 0,
            trendUp,
            nearHigh,
            breakout6h,
            atrPct: Math.round(atrPct * 10) / 10,
            hasVolatility,
            dropFromHigh: Math.round(dropFromHigh * 10) / 10,
            sector: sector ? sector.label : null,
            sectorKey: sector ? sector.key : null,
            score: _calcSpikeScore(spikeRatio, trendUp, nearHigh, coin.change24h, breakout6h, hasVolatility, coin.volume),
          });
        }

        await new Promise(r => setTimeout(r, 200));
      } catch {}
    }

    spikes.sort((a, b) => b.score - a.score);
    if (spikes.length > 0) {
      const top = spikes.slice(0, 3).map(s => `${s.symbol} Vol:${s.spikeRatio}x Score:${s.score}`).join(', ');
      console.log(`[VolDetect] ${spikes.length} spikes (${skippedLiq} baja liquidez, ${skippedPump} pump >25% ignorados): ${top}`);
    }
  } catch (e) {
    console.warn('[VolDetect] Error:', (e.message || '').substring(0, 60));
  }

  return spikes;
}

function _calcSpikeScore(spikeRatio, trendUp, nearHigh, change24h, breakout6h, hasVolatility, volume24h) {
  let score = 0;

  // Volumen anormal (factor principal)
  if (spikeRatio >= 10) score += 4;
  else if (spikeRatio >= 5) score += 3;
  else if (spikeRatio >= 3) score += 2;

  // Tendencia alcista (EMA20 > EMA50)
  if (trendUp) score += 2;

  // Precio cerca del máximo (pump activo, no terminó)
  if (nearHigh) score += 2;

  // Breakout: rompiendo máximo de 6h = confirmación fuerte
  if (breakout6h) score += 3;

  // Volatilidad real (evitar mercados muertos)
  if (hasVolatility) score += 1;

  // Liquidez alta = señal más confiable
  if (volume24h >= 50_000_000) score += 2;      // >$50M = muy líquido
  else if (volume24h >= 20_000_000) score += 1;  // >$20M = ok

  // Cambio 24h: zona óptima 3-15% (inicio de tendencia, no final de pump)
  if (change24h >= 3 && change24h <= 10) score += 3;  // Zona ideal: inicio
  else if (change24h > 10 && change24h <= 20) score += 1; // Moderado
  else if (change24h > 20) score -= 2;  // Probable final de pump

  return Math.max(0, score);
}

// ── Análisis sectorial: buscar oportunidades en sectores específicos ──────────

async function analyzeSectors() {
  const results = [];

  for (const [key, sector] of Object.entries(SECTOR_CRYPTOS)) {
    const sectorData = { key, label: sector.label, coins: [] };

    for (const pair of sector.pairs) {
      try {
        const ticker = await getTicker(pair);
        if (!ticker || !ticker.last || ticker.last <= 0) continue;

        const candles = await getOHLCV(pair, '1h', 24);
        let trendUp = false;
        let rsi = 50;

        if (candles && candles.length >= 12) {
          const closes = candles.map(c => c[4]);
          const ema20 = calculateEMA(closes, Math.min(20, closes.length));
          const ema50 = calculateEMA(closes, Math.min(50, closes.length));
          trendUp = ema20 > ema50 && closes[closes.length - 1] > ema20;

          // RSI simple
          rsi = _quickRSI(closes);
        }

        sectorData.coins.push({
          symbol: pair,
          price: ticker.last,
          change24h: ticker.percentage || 0,
          volume: ticker.quoteVolume || 0,
          trendUp,
          rsi: Math.round(rsi),
        });

        await new Promise(r => setTimeout(r, 300));
      } catch {}
    }

    if (sectorData.coins.length > 0) {
      // Calcular tendencia del sector (promedio de cambios)
      const avgChange = sectorData.coins.reduce((a, c) => a + c.change24h, 0) / sectorData.coins.length;
      const bullishCount = sectorData.coins.filter(c => c.trendUp).length;
      sectorData.avgChange = Math.round(avgChange * 10) / 10;
      sectorData.sentiment = bullishCount > sectorData.coins.length / 2 ? 'BULLISH' : 'NEUTRAL';
      results.push(sectorData);
    }
  }

  return results;
}

function _quickRSI(closes) {
  const period = 14;
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - diff) / period;
    }
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

// ── Multi-Timeframe Analysis: 1h trend + 15m entry ───────────────────────────

async function multiTimeframeCheck(symbol) {
  try {
    // 1h: tendencia general (72 velas = 3 días de contexto)
    const candles1h = await getOHLCV(symbol, '1h', 72);
    if (!candles1h || candles1h.length < 24) return { ok: false, reason: 'Sin datos 1h' };

    const closes1h = candles1h.map(c => c[4]);
    const ema20_1h = calculateEMA(closes1h, 20);
    const ema50_1h = calculateEMA(closes1h, Math.min(50, closes1h.length));
    const price = closes1h[closes1h.length - 1];
    const trend1h = ema20_1h > ema50_1h && price > ema20_1h;

    if (!trend1h) {
      return { ok: false, reason: 'Tendencia 1h bajista (EMA20 < EMA50)' };
    }

    // ATR: verificar que hay volatilidad suficiente
    const atr = calculateATR(candles1h, 14);
    const atrPct = price > 0 ? (atr / price) * 100 : 0;
    if (atrPct < 0.3) {
      return { ok: false, reason: `Volatilidad muy baja (ATR ${atrPct.toFixed(1)}%)` };
    }

    // Breakout: precio rompiendo máximo de 6h
    const high6h = Math.max(...candles1h.slice(-6).map(c => c[2]));
    const breakout = price >= high6h * 0.99;

    await new Promise(r => setTimeout(r, 200));

    // 15m: timing de entrada
    const candles15m = await getOHLCV(symbol, '15m', 20);
    if (!candles15m || candles15m.length < 15) return { ok: true, trend1h: true, rsi15m: 50, breakout };

    const closes15m = candles15m.map(c => c[4]);
    const rsi15m = _quickRSI(closes15m);

    return {
      ok: rsi15m < 70,
      trend1h: true,
      rsi15m: Math.round(rsi15m),
      atrPct: Math.round(atrPct * 10) / 10,
      breakout,
      reason: rsi15m >= 70 ? `RSI 15m=${Math.round(rsi15m)} sobrecomprada` : null,
    };
  } catch (e) {
    return { ok: false, reason: 'Error multi-timeframe: ' + (e.message || '').substring(0, 30) };
  }
}

// ── Order Flow Imbalance (OFI) ────────────────────────────────────────────────
// Analiza bids vs asks en el order book para detectar presión compradora
// OFI > 1.5 = presión compradora, > 2.0 = posible breakout, > 3.0 = pump probable

async function getOrderFlowImbalance(symbol) {
  try {
    const ob = await getOrderBook(symbol, 20);
    if (!ob || !ob.bids || !ob.asks || !ob.bids.length || !ob.asks.length) {
      return { ofi: 1, bidVolume: 0, askVolume: 0 };
    }

    // Sumar volumen en USD de los top 20 niveles de bids y asks
    let bidVolume = 0, askVolume = 0;
    for (const [price, amount] of ob.bids) {
      bidVolume += price * amount;
    }
    for (const [price, amount] of ob.asks) {
      askVolume += price * amount;
    }

    const ofi = askVolume > 0 ? bidVolume / askVolume : 1;

    return {
      ofi: Math.round(ofi * 100) / 100,
      bidVolume: Math.round(bidVolume),
      askVolume: Math.round(askVolume),
    };
  } catch (e) {
    return { ofi: 1, bidVolume: 0, askVolume: 0 };
  }
}

// ── Volatility Compression Detection ──────────────────────────────────────────
// ATR bajo + volumen subiendo = setup pre-pump (compresión antes de explosión)

function detectVolatilityCompression(candles) {
  if (!candles || candles.length < 24) return { compressed: false };

  // ATR de las últimas 6h vs ATR de las últimas 24h
  const atr24h = calculateATR(candles.slice(-24), 14);
  const atr6h = calculateATR(candles.slice(-6), 5);
  if (atr24h <= 0) return { compressed: false };

  const compressionRatio = atr6h / atr24h;

  // Volumen: comparar últimas 3h vs promedio
  const vols = candles.map(c => c[5]);
  const avgVol = vols.slice(0, -3).reduce((a, b) => a + b, 0) / (vols.length - 3);
  const recentVol = vols.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const volRising = avgVol > 0 ? recentVol / avgVol : 1;

  // Compresión: volatilidad baja + volumen subiendo = setup
  const compressed = compressionRatio < 0.6 && volRising > 1.5;

  return {
    compressed,
    compressionRatio: Math.round(compressionRatio * 100) / 100,
    volRising: Math.round(volRising * 10) / 10,
  };
}

// ── BTC Global Filter ─────────────────────────────────────────────────────────
// Si BTC está bajista (EMA20 < EMA50), el mercado entero tiende a caer
// → reducir trades o no comprar altcoins

let _btcTrendCache = null;
let _btcTrendCacheTs = 0;
const BTC_CACHE_TTL = 5 * 60 * 1000; // 5 min

async function getBTCTrend() {
  const now = Date.now();
  if (_btcTrendCache && (now - _btcTrendCacheTs) < BTC_CACHE_TTL) return _btcTrendCache;

  try {
    const candles = await getOHLCV('BTC/USDT', '1h', 72);
    if (!candles || candles.length < 24) return { bullish: true, label: 'UNKNOWN' };

    const closes = candles.map(c => c[4]);
    const price = closes[closes.length - 1];
    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, Math.min(50, closes.length));

    const bullish = ema20 > ema50 && price > ema20;
    const bearish = ema20 < ema50 && price < ema20;

    // Cambio 24h de BTC
    const price24hAgo = closes.length >= 24 ? closes[closes.length - 24] : closes[0];
    const change24h = ((price - price24hAgo) / price24hAgo) * 100;

    const result = {
      bullish,
      bearish,
      label: bullish ? 'BULLISH' : bearish ? 'BEARISH' : 'NEUTRAL',
      price,
      ema20: Math.round(ema20),
      ema50: Math.round(ema50),
      change24h: Math.round(change24h * 10) / 10,
    };

    _btcTrendCache = result;
    _btcTrendCacheTs = now;
    return result;
  } catch {
    return { bullish: true, label: 'UNKNOWN', change24h: 0 };
  }
}

// ── Kill Switch ───────────────────────────────────────────────────────────────
// Si el bot perdió más de X% hoy, detenerse

function shouldKillSwitch(db, maxLossPct) {
  maxLossPct = maxLossPct || 5;
  try {
    const today = new Date().toISOString().split('T')[0];
    const row = db.prepare(
      "SELECT SUM(pnl) as total_pnl FROM crypto_positions WHERE status = 'CLOSED' AND order_id NOT LIKE 'PAPER%' AND closed_at >= ?"
    ).get(today + 'T00:00:00');
    const todayPnl = row?.total_pnl || 0;

    // Calcular pérdida como % del portfolio
    // Si perdió más de $maxLossPct worth → kill
    if (todayPnl < 0 && Math.abs(todayPnl) > maxLossPct) {
      return { kill: true, reason: `Kill switch: perdida hoy $${Math.abs(todayPnl).toFixed(2)} > $${maxLossPct}`, todayPnl };
    }
    return { kill: false, todayPnl };
  } catch {
    return { kill: false, todayPnl: 0 };
  }
}

module.exports = {
  SECTOR_CRYPTOS,
  MIN_VOLUME_24H,
  MAX_PUMP_24H,
  getAllSectorPairs,
  getSectorForSymbol,
  calculateEMA,
  calculateATR,
  detectVolumeSpikes,
  analyzeSectors,
  multiTimeframeCheck,
  getOrderFlowImbalance,
  detectVolatilityCompression,
  getBTCTrend,
  shouldKillSwitch,
};
