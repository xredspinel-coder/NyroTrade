'use strict';

const { clamp, safeNumber } = require('../utils/format');

function average(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length === 0) return 0;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function stddev(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length < 2) return 0;
  const mean = average(filtered);
  const variance = average(filtered.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function candleClose(candle) {
  return safeNumber(candle && candle[4]);
}

function candleOpen(candle) {
  return safeNumber(candle && candle[1]);
}

function candleHigh(candle) {
  return safeNumber(candle && candle[2]);
}

function candleLow(candle) {
  return safeNumber(candle && candle[3]);
}

function candleVolume(candle) {
  return safeNumber(candle && candle[5]);
}

function ema(values, period) {
  const filtered = values.filter((value) => Number.isFinite(value) && value > 0);
  if (filtered.length === 0) return 0;
  const window = Math.max(1, Math.trunc(period || 1));
  const multiplier = 2 / (window + 1);
  let current = average(filtered.slice(0, Math.min(window, filtered.length)));
  for (const value of filtered.slice(Math.min(window, filtered.length))) {
    current = (value - current) * multiplier + current;
  }
  return current;
}

function trueRanges(candles) {
  const ranges = [];
  let lastClose = 0;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const high = candleHigh(candle);
    const low = candleLow(candle);
    const candleCloseValue = candleClose(candle);
    const previousClose = index > 0 ? (lastClose || candleClose(candles[index - 1])) : candleCloseValue;
    if (!(high > 0) || !(low > 0)) continue;
    ranges.push(Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose)
    ));
    if (candleCloseValue > 0) lastClose = candleCloseValue;
  }
  return ranges;
}

function atr(candles, period = 14) {
  const ranges = trueRanges(candles).slice(-period);
  const value = average(ranges);
  if (value > 0) return value;
  // Fallback: if TR computation yields 0 due to sparse/malformed candles,
  // approximate ATR from average high-low ranges.
  const usable = (candles || []).filter((candle) => Array.isArray(candle) && candle.length >= 6);
  const window = usable.slice(-period);
  const hl = window
    .map((candle) => {
      const h = candleHigh(candle);
      const l = candleLow(candle);
      return h > 0 && l > 0 ? (h - l) : null;
    })
    .filter((v) => v !== null);
  return average(hl);
}

function countBullishConfirmation(candles, count) {
  const recent = candles.slice(-count);
  return recent.filter((candle, index) => {
    const open = candleOpen(candle);
    const close = candleClose(candle);
    const previous = index > 0 ? candleClose(recent[index - 1]) : candleClose(candles[candles.length - count - 1]);
    return close > open && (!previous || close >= previous);
  }).length;
}

function countBearishConfirmation(candles, count) {
  const recent = candles.slice(-count);
  return recent.filter((candle, index) => {
    const open = candleOpen(candle);
    const close = candleClose(candle);
    const previous = index > 0 ? candleClose(recent[index - 1]) : candleClose(candles[candles.length - count - 1]);
    return close < open && (!previous || close <= previous);
  }).length;
}

function momentumPersistence(candles, count) {
  const recent = candles.slice(-count - 1);
  if (recent.length < 2) return 0;
  const positives = recent.slice(1).filter((candle, index) => {
    const previous = candleClose(recent[index]);
    const close = candleClose(candle);
    return previous > 0 && close > previous;
  }).length;
  return positives / Math.max(1, recent.length - 1);
}

function latestReturn(candles) {
  if (candles.length < 2) return 0;
  const previous = candleClose(candles[candles.length - 2]);
  const close = candleClose(candles[candles.length - 1]);
  return previous > 0 ? (close - previous) / previous : 0;
}

function breakoutStats(candles, config) {
  const lookback = candles.slice(-24, -1);
  const last = candles[candles.length - 1];
  const lastClose = candleClose(last);
  const lastHigh = candleHigh(last);
  const lastLow = candleLow(last);
  const previousHigh = Math.max(...lookback.map(candleHigh).filter((value) => value > 0), lastClose);
  const minBreakout = config.risk.minBreakoutPercent;
  const breakoutPercent = previousHigh > 0 ? (lastClose - previousHigh) / previousHigh : 0;
  const confirmed = breakoutPercent >= minBreakout;
  const candleRange = lastHigh - lastLow;
  const upperWick = lastHigh - Math.max(lastClose, candleOpen(last));
  const upperWickRatio = candleRange > 0 ? upperWick / candleRange : 0;
  const fakeBreakoutRisk = lastHigh > previousHigh
    && (!confirmed || upperWickRatio > 0.55);

  return {
    breakoutPercent,
    breakoutConfirmed: confirmed,
    upperWickRatio,
    fakeBreakoutRisk
  };
}

function computeMemeScore(symbol, market, memeMode) {
  if (!memeMode) return 0;
  const base = String((market && market.base) || symbol.split('/')[0] || '').toUpperCase();
  const name = `${base} ${(market && market.info && market.info.baseAsset) || ''} ${(market && market.info && market.info.symbol) || ''}`.toLowerCase();
  const memeBases = new Set(['DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'TURBO', 'BOME', 'MEME', 'MOG', 'PONKE', 'NEIRO', 'BABYDOGE']);
  const memeWords = ['dog', 'inu', 'pepe', 'cat', 'meme', 'bonk', 'floki', 'moon', 'wojak', 'frog'];
  if (memeBases.has(base)) return 1;
  return memeWords.some((word) => name.includes(word)) ? 0.7 : 0;
}

function analyzeMarket({ symbol, ticker, candles, highTimeframeCandles, market, marketCap, config }) {
  const usableCandles = (candles || []).filter((candle) => Array.isArray(candle) && candle.length >= 6);
  const higherCandles = (highTimeframeCandles || []).filter((candle) => Array.isArray(candle) && candle.length >= 6);
  const lastPrice = safeNumber(ticker && ticker.last) || candleClose(usableCandles[usableCandles.length - 1]);
  const firstClose = candleClose(usableCandles[0]) || lastPrice;
  const lastClose = candleClose(usableCandles[usableCandles.length - 1]) || lastPrice;
  const previousClose = candleClose(usableCandles[usableCandles.length - 2]) || firstClose;
  const priceChange = firstClose > 0 ? (lastClose - firstClose) / firstClose : 0;
  const shortChange = previousClose > 0 ? (lastClose - previousClose) / previousClose : 0;

  const recentWindow = usableCandles.slice(-6);
  const priorWindow = usableCandles.slice(-18, -6);
  const recentStart = candleClose(recentWindow[0]) || lastClose;
  const priorStart = candleClose(priorWindow[0]) || firstClose;
  const recentMomentum = recentStart > 0 ? (lastClose - recentStart) / recentStart : 0;
  const priorClose = candleClose(priorWindow[priorWindow.length - 1]) || recentStart;
  const priorMomentum = priorStart > 0 ? (priorClose - priorStart) / priorStart : 0;
  const acceleration = recentMomentum - priorMomentum;

  const recentVolume = average(recentWindow.map(candleVolume));
  const priorVolume = average(priorWindow.map(candleVolume));
  const tickerVolume = safeNumber(ticker && (ticker.quoteVolume || ticker.baseVolume));
  const volumeDataOk = priorWindow.length >= 4 && recentWindow.length >= 3;
  const volumeRatio = !volumeDataOk
    ? 1
    : (priorVolume > 0 ? recentVolume / priorVolume : (recentVolume > 0 ? 1.05 : 1));

  const closes = usableCandles.map(candleClose).filter((value) => value > 0);
  const returns = closes.slice(1).map((close, index) => {
    const prev = closes[index];
    return prev > 0 ? (close - prev) / prev : 0;
  });
  const rollingStddev = stddev(returns.slice(-24));
  const volatility = stddev(returns) * Math.sqrt(Math.max(1, returns.length));
  const highs = usableCandles.map(candleHigh).filter((value) => value > 0);
  const lows = usableCandles.map(candleLow).filter((value) => value > 0);
  const high = Math.max(...highs, lastPrice);
  const low = Math.min(...lows, lastPrice);
  const range = lastPrice > 0 && Number.isFinite(high) && Number.isFinite(low) ? (high - low) / lastPrice : 0;
  const candleRanges = usableCandles.map((candle) => {
    const highValue = candleHigh(candle);
    const lowValue = candleLow(candle);
    const closeValue = candleClose(candle);
    return closeValue > 0 ? (highValue - lowValue) / closeValue : 0;
  }).filter((value) => Number.isFinite(value));
  const averageCandleRange = average(candleRanges.slice(-24));
  const atrValue = atr(usableCandles, 14);
  const rawAtrPercent = lastPrice > 0 ? atrValue / lastPrice : 0;
  const atrPercent = rawAtrPercent > 0 ? rawAtrPercent : (averageCandleRange > 0 ? averageCandleRange * 0.85 : 0.0015);

  const bid = safeNumber(ticker && ticker.bid);
  const ask = safeNumber(ticker && ticker.ask);
  const spread = bid > 0 && ask > bid ? (ask - bid) / ((ask + bid) / 2) : null;
  const dailyChange = safeNumber(ticker && ticker.percentage) / 100;
  const memeScore = computeMemeScore(symbol, market, config.scanner.memeMode);
  const emaFast = ema(closes, config.risk.emaFastPeriod);
  const emaSlow = ema(closes, config.risk.emaSlowPeriod);
  const emaTrendOk = emaFast > emaSlow && lastClose >= emaFast;
  const higherCloses = higherCandles.map(candleClose).filter((value) => value > 0);
  const higherRecent = higherCloses.slice(-6);
  const higherPrevious = higherCloses.slice(-18, -6);
  const higherStart = higherRecent[0] || higherCloses[0] || lastPrice;
  const higherLast = higherRecent[higherRecent.length - 1] || lastPrice;
  const higherPriorStart = higherPrevious[0] || higherStart;
  const higherPriorLast = higherPrevious[higherPrevious.length - 1] || higherStart;
  const higherTimeframeMomentum = higherStart > 0 ? (higherLast - higherStart) / higherStart : 0;
  const higherPriorMomentum = higherPriorStart > 0 ? (higherPriorLast - higherPriorStart) / higherPriorStart : 0;
  const higherTimeframeTrendOk = higherTimeframeMomentum >= 0 && higherTimeframeMomentum >= higherPriorMomentum * 0.5;
  const confirmationWindow = Math.max(1, config.risk.confirmationCandles);
  const bullishConfirmationCandles = countBullishConfirmation(usableCandles, confirmationWindow);
  const bearishConfirmationCandles = countBearishConfirmation(usableCandles, Math.max(1, config.risk.exitConfirmationCandles));
  const momentumPersistenceScore = momentumPersistence(usableCandles, confirmationWindow + 1);
  const positiveReturns = returns.slice(-6).filter((value) => value > 0);
  const negativeReturns = returns.slice(-6).filter((value) => value < 0);
  const momentumDecay = negativeReturns.length > positiveReturns.length
    ? Math.abs(average(negativeReturns)) + Math.max(0, -acceleration)
    : 0;
  const singleCandleMove = latestReturn(usableCandles);
  const oneCandlePump = singleCandleMove * 100 >= config.scanner.suspiciousSingleCandlePercent
    && momentumPersistenceScore < config.risk.minMomentumPersistence;
  const breakout = breakoutStats(usableCandles, config);
  const abnormalPump = Math.max(priceChange, recentMomentum, dailyChange) * 100 >= config.scanner.abnormalPumpPercent;
  const spreadPenalty = spread === null ? 0 : clamp(spread / Math.max(config.scanner.maxSpread, 0.0001), 0, 1);

  const volatilityScore = clamp(
    (clamp(atrPercent / 0.035, 0, 1) * 0.34)
      + (clamp(rollingStddev / 0.02, 0, 1) * 0.22)
      + (clamp(averageCandleRange / 0.045, 0, 1) * 0.18)
      + (clamp(Math.abs(dailyChange) / 0.18, 0, 1) * 0.12)
      + (clamp((volumeRatio - 1) / 4, 0, 1) * 0.1)
      + (memeScore * 0.04)
      - (spreadPenalty * 0.12),
    0,
    1
  );

  const momentumScore = clamp(
    clamp(priceChange * 3, 0, 0.35) * 0.3
      + clamp(recentMomentum * 4, 0, 0.35) * 0.35
      + clamp(acceleration * 2, -0.15, 0.25) * 0.15
      + clamp((volumeRatio - 1) / 2, 0, 0.3) * 0.2,
    0,
    1
  );

  const liquidityScore = clamp(Math.log10(Math.max(1, tickerVolume)) / 9, 0, 1);
  const rankScore = clamp(
    (volatilityScore * 0.32)
      + (momentumScore * 0.25)
      + (liquidityScore * 0.18)
      + (breakout.breakoutConfirmed ? 0.08 : 0)
      + (emaTrendOk ? 0.08 : 0)
      + (higherTimeframeTrendOk ? 0.05 : 0)
      + (memeScore * 0.04)
      - (breakout.fakeBreakoutRisk ? 0.12 : 0)
      - (oneCandlePump ? 0.14 : 0),
    0,
    1
  );

  return {
    symbol,
    analyzedAt: new Date().toISOString(),
    price: lastPrice,
    quoteVolume: tickerVolume,
    marketCapUsd: marketCap ? marketCap.marketCapUsd : null,
    marketCapRank: marketCap ? marketCap.rank : null,
    priceChange,
    shortChange,
    recentMomentum,
    acceleration,
    volumeRatio,
    volumeDataOk,
    volatility,
    rollingStddev,
    atr: atrValue,
    atrPercent,
    averageCandleRange,
    range,
    dailyChange,
    spread,
    emaFast,
    emaSlow,
    emaTrendOk,
    higherTimeframeMomentum,
    higherTimeframeTrendOk,
    bullishConfirmationCandles,
    bearishConfirmationCandles,
    momentumPersistence: momentumPersistenceScore,
    momentumDecay,
    singleCandleMove,
    oneCandlePump,
    abnormalPump,
    breakoutPercent: breakout.breakoutPercent,
    breakoutConfirmed: breakout.breakoutConfirmed,
    upperWickRatio: breakout.upperWickRatio,
    fakeBreakoutRisk: breakout.fakeBreakoutRisk,
    volatilityScore,
    momentumScore,
    liquidityScore,
    memeScore,
    rankScore,
    candles: usableCandles.length
  };
}

module.exports = {
  atr,
  analyzeMarket,
  average,
  computeMemeScore
};
