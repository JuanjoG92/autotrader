// src/services/volume-detector.js
// Detección de anomalías de volumen + análisis sectorial de criptos
// Método profesional: detectar pumps ANTES de que ocurran por volumen anormal

const { getTopGainers, getTicker, getOHLCV } = require('./binance');

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

// ── Volume Spike Detection ────────────────────────────────────────────────────
// Detecta anomalías de volumen: si el volumen actual es X veces mayor que el
// promedio, indica que hay dinero entrando → posible pump inminente

async function detectVolumeSpikes(minRatio) {
  minRatio = minRatio || 3; // Default: 3x el volumen promedio
  const spikes = [];

  try {
    const gainers = await getTopGainers(30);
    if (!gainers || !gainers.length) return spikes;

    for (const coin of gainers) {
      try {
        // Obtener velas de 1h para calcular volumen promedio
        const candles = await getOHLCV(coin.symbol, '1h', 24);
        if (!candles || candles.length < 12) continue;

        // Volumen promedio de las últimas 24h (excluyendo la última vela)
        const volumes = candles.slice(0, -1).map(c => c[5]); // c[5] = volume
        const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
        if (avgVolume <= 0) continue;

        // Volumen de la última vela
        const currentVolume = candles[candles.length - 1][5];
        const spikeRatio = currentVolume / avgVolume;

        if (spikeRatio >= minRatio) {
          // Calcular EMA trend (1h)
          const closes = candles.map(c => c[4]);
          const ema20 = calculateEMA(closes, Math.min(20, closes.length));
          const ema50 = calculateEMA(closes, Math.min(50, closes.length));
          const currentPrice = closes[closes.length - 1];
          const trendUp = ema20 > ema50 && currentPrice > ema20;

          // Precio vs máximo reciente
          const recentHigh = Math.max(...candles.slice(-6).map(c => c[2]));
          const dropFromHigh = ((recentHigh - currentPrice) / recentHigh) * 100;
          const nearHigh = dropFromHigh < 3;

          const sector = getSectorForSymbol(coin.symbol);

          spikes.push({
            symbol: coin.symbol,
            price: currentPrice,
            change24h: coin.change24h || 0,
            spikeRatio: Math.round(spikeRatio * 10) / 10,
            avgVolume: Math.round(avgVolume),
            currentVolume: Math.round(currentVolume),
            trendUp,
            nearHigh,
            dropFromHigh: Math.round(dropFromHigh * 10) / 10,
            sector: sector ? sector.label : null,
            sectorKey: sector ? sector.key : null,
            // Score compuesto: volumen + tendencia + proximidad al máximo
            score: _calcSpikeScore(spikeRatio, trendUp, nearHigh, coin.change24h),
          });
        }

        await new Promise(r => setTimeout(r, 200)); // Rate limit
      } catch {}
    }

    spikes.sort((a, b) => b.score - a.score);
    if (spikes.length > 0) {
      const top = spikes.slice(0, 3).map(s => `${s.symbol} Vol:${s.spikeRatio}x Score:${s.score}`).join(', ');
      console.log(`[VolDetect] ${spikes.length} spikes detectados: ${top}`);
    }
  } catch (e) {
    console.warn('[VolDetect] Error:', (e.message || '').substring(0, 60));
  }

  return spikes;
}

function _calcSpikeScore(spikeRatio, trendUp, nearHigh, change24h) {
  let score = 0;

  // Volumen anormal (factor principal)
  if (spikeRatio >= 10) score += 4;
  else if (spikeRatio >= 5) score += 3;
  else if (spikeRatio >= 3) score += 2;

  // Tendencia alcista (EMA20 > EMA50)
  if (trendUp) score += 2;

  // Precio cerca del máximo (pump activo, no terminó)
  if (nearHigh) score += 2;

  // Cambio 24h moderado (5-30% = zona óptima, >50% = pump agotado)
  if (change24h >= 5 && change24h <= 15) score += 2;
  else if (change24h > 15 && change24h <= 30) score += 1;
  else if (change24h > 50) score -= 1;

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
    // 1h: tendencia general
    const candles1h = await getOHLCV(symbol, '1h', 24);
    if (!candles1h || candles1h.length < 12) return { ok: false, reason: 'Sin datos 1h' };

    const closes1h = candles1h.map(c => c[4]);
    const ema20_1h = calculateEMA(closes1h, Math.min(20, closes1h.length));
    const ema50_1h = calculateEMA(closes1h, Math.min(50, closes1h.length));
    const price = closes1h[closes1h.length - 1];
    const trend1h = ema20_1h > ema50_1h && price > ema20_1h;

    if (!trend1h) {
      return { ok: false, reason: 'Tendencia 1h bajista (EMA20 < EMA50)' };
    }

    await new Promise(r => setTimeout(r, 200));

    // 15m: timing de entrada
    const candles15m = await getOHLCV(symbol, '15m', 20);
    if (!candles15m || candles15m.length < 15) return { ok: true, trend1h: true, rsi15m: 50 };

    const closes15m = candles15m.map(c => c[4]);
    const rsi15m = _quickRSI(closes15m);

    return {
      ok: rsi15m < 70,
      trend1h: true,
      rsi15m: Math.round(rsi15m),
      reason: rsi15m >= 70 ? `RSI 15m=${Math.round(rsi15m)} sobrecomprada` : null,
    };
  } catch (e) {
    return { ok: false, reason: 'Error multi-timeframe: ' + (e.message || '').substring(0, 30) };
  }
}

module.exports = {
  SECTOR_CRYPTOS,
  getAllSectorPairs,
  getSectorForSymbol,
  calculateEMA,
  detectVolumeSpikes,
  analyzeSectors,
  multiTimeframeCheck,
};
