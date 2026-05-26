'use strict';

const { average, atr } = require('../strategies/metrics');
const { clamp, safeNumber } = require('../utils/format');

function close(candle) {
  return safeNumber(candle && candle[4]);
}

class MarketRegimeService {
  constructor({ exchange, storage, config, logger }) {
    this.exchange = exchange;
    this.storage = storage;
    this.config = config;
    this.logger = logger;
    this.current = null;
  }

  async refresh() {
    const symbols = [`BTC/${this.config.exchange.baseSymbol}`, `ETH/${this.config.exchange.baseSymbol}`];
    const results = [];
    for (const symbol of symbols) {
      try {
        const candles = await this.exchange.getOhlcv(symbol, this.config.exchange.higherTimeframe, this.config.exchange.higherTimeframeLimit);
        results.push(this.analyzeSymbol(symbol, candles));
      } catch (error) {
        this.logger.warn('Market regime symbol unavailable', { symbol, error });
      }
    }

    const topVolatile = await this.storage.getTopVolatility(20).catch(() => []);
    const avgVolatility = average(topVolatile.map((item) => Number(item.volatilityScore || 0)));
    const avgLiquidity = average(topVolatile.map((item) => Number(item.liquidityScore || 0)));
    const avgVolumeRatio = average(topVolatile.map((item) => Number(item.volumeRatio || 1)));
    const fakeBreakoutRate = topVolatile.length > 0
      ? topVolatile.filter((item) => item.fakeBreakoutRisk).length / topVolatile.length
      : 0;
    const momentum = average(results.map((item) => item.momentum));
    const atrPercent = average(results.map((item) => item.atrPercent));
    const trendScore = clamp((momentum / 0.04) + 0.5, 0, 1);
    const chaosScore = clamp((atrPercent / 0.04) * 0.55 + avgVolatility * 0.45, 0, 1);
    const liquidityScore = avgLiquidity || 0.5;
    const euphoriaScore = clamp((momentum / 0.06) + (avgVolumeRatio - 1) / 3, 0, 1);
    const panicScore = clamp((-momentum / 0.05) + chaosScore * 0.35, 0, 1);
    const manipulationScore = clamp(fakeBreakoutRate * 0.7 + (avgVolumeRatio > 2.5 ? 0.2 : 0), 0, 1);

    let regime = 'sideways';
    if (liquidityScore < 0.45) regime = 'low_liquidity';
    else if (manipulationScore > 0.55 && avgVolumeRatio > 2) regime = 'whale_manipulation';
    else if (panicScore > 0.62 && momentum < -0.01) regime = 'panic';
    else if (euphoriaScore > 0.72 && momentum > 0.02) regime = 'euphoria';
    else if (chaosScore > 0.78) regime = 'high_volatility_chaos';
    else if (trendScore > 0.62 && momentum > 0) regime = 'trending';

    const aggressiveness = clamp(
      0.55
        + (regime === 'trending' ? 0.18 : 0)
        + (regime === 'euphoria' ? 0.05 : 0)
        - (regime === 'high_volatility_chaos' ? 0.25 : 0)
        - (regime === 'low_liquidity' ? 0.3 : 0)
        - (regime === 'sideways' ? 0.1 : 0)
        - (regime === 'panic' ? 0.28 : 0)
        - (regime === 'whale_manipulation' ? 0.2 : 0),
      0.15,
      1
    );

    this.current = {
      regime,
      aggressiveness,
      trendScore,
      chaosScore,
      liquidityScore,
      euphoriaScore,
      panicScore,
      manipulationScore,
      momentum,
      atrPercent,
      avgVolumeRatio,
      fakeBreakoutRate,
      drivers: results,
      source: 'BTC_ETH_HTF_PLUS_WATCHLIST'
    };
    await this.storage.saveMarketRegime(this.current);
    this.logger.info('Market regime refreshed', this.current);
    return this.current;
  }

  async getCurrent() {
    if (this.current) return this.current;
    const stored = await this.storage.getMarketRegime();
    if (stored) {
      this.current = stored;
      return stored;
    }
    return this.refresh();
  }

  analyzeSymbol(symbol, candles) {
    const usable = (candles || []).filter((candle) => Array.isArray(candle));
    const closes = usable.map(close).filter((value) => value > 0);
    const first = closes[Math.max(0, closes.length - 12)] || closes[0] || 0;
    const last = closes[closes.length - 1] || 0;
    const momentum = first > 0 ? (last - first) / first : 0;
    const atrValue = atr(usable, 14);
    const atrPercent = last > 0 ? Math.max(atrValue / last, 0.0015) : 0.0015;
    return { symbol, momentum, atrPercent };
  }
}

module.exports = MarketRegimeService;
