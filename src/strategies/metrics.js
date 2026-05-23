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

function candleVolume(candle) {
  return safeNumber(candle && candle[5]);
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

function analyzeMarket({ symbol, ticker, candles, market, marketCap, config }) {
  const usableCandles = (candles || []).filter((candle) => Array.isArray(candle) && candle.length >= 6);
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
  const volumeRatio = priorVolume > 0 ? recentVolume / priorVolume : (recentVolume > 0 ? 2 : 0);

  const closes = usableCandles.map(candleClose).filter((value) => value > 0);
  const returns = closes.slice(1).map((close, index) => {
    const prev = closes[index];
    return prev > 0 ? (close - prev) / prev : 0;
  });
  const volatility = stddev(returns) * Math.sqrt(Math.max(1, returns.length));
  const highs = usableCandles.map((candle) => safeNumber(candle[2])).filter((value) => value > 0);
  const lows = usableCandles.map((candle) => safeNumber(candle[3])).filter((value) => value > 0);
  const high = Math.max(...highs, lastPrice);
  const low = Math.min(...lows, lastPrice);
  const range = lastPrice > 0 && Number.isFinite(high) && Number.isFinite(low) ? (high - low) / lastPrice : 0;

  const bid = safeNumber(ticker && ticker.bid);
  const ask = safeNumber(ticker && ticker.ask);
  const spread = bid > 0 && ask > bid ? (ask - bid) / ((ask + bid) / 2) : null;
  const dailyChange = safeNumber(ticker && ticker.percentage) / 100;
  const memeScore = computeMemeScore(symbol, market, config.scanner.memeMode);

  const volatilityScore = clamp(
    (Math.abs(volatility) * 7)
      + (Math.abs(range) * 2.5)
      + (Math.abs(dailyChange) * 0.6)
      + clamp((volumeRatio - 1) / 4, 0, 0.35)
      + (memeScore * 0.08),
    0,
    1
  );

  const momentumScore = clamp(
    (priceChange * 5)
      + (recentMomentum * 7)
      + (acceleration * 4)
      + clamp((volumeRatio - 1) / 3, 0, 0.4),
    0,
    1
  );

  const liquidityScore = clamp(Math.log10(Math.max(1, tickerVolume)) / 9, 0, 1);
  const rankScore = clamp(
    (volatilityScore * 0.42)
      + (momentumScore * 0.28)
      + (liquidityScore * 0.18)
      + (memeScore * 0.12),
    0,
    1
  );

  return {
    symbol,
    price: lastPrice,
    quoteVolume: tickerVolume,
    marketCapUsd: marketCap ? marketCap.marketCapUsd : null,
    marketCapRank: marketCap ? marketCap.rank : null,
    priceChange,
    shortChange,
    recentMomentum,
    acceleration,
    volumeRatio,
    volatility,
    range,
    dailyChange,
    spread,
    volatilityScore,
    momentumScore,
    liquidityScore,
    memeScore,
    rankScore,
    candles: usableCandles.length
  };
}

module.exports = {
  analyzeMarket,
  computeMemeScore
};
