'use strict';

const { analyzeMarket } = require('../strategies/metrics');

class MarketAnalyzer {
  constructor({ exchange, marketCap, config, logger }) {
    this.exchange = exchange;
    this.marketCap = marketCap;
    this.config = config;
    this.logger = logger;
  }

  async analyzeSymbol(symbol) {
    const market = this.exchange.cache.getMarket(symbol);
    const [ticker, candles, cap] = await Promise.all([
      this.exchange.getTicker(symbol),
      this.exchange.getOhlcv(symbol),
      market ? this.marketCap.getMarketCap(market.base) : Promise.resolve(null)
    ]);
    const highTimeframeCandles = await this.exchange.getOhlcv(
      symbol,
      this.config.exchange.higherTimeframe,
      this.config.exchange.higherTimeframeLimit
    ).catch((error) => {
      this.logger.warn('Higher timeframe candles unavailable; trend filter will be conservative', {
        symbol,
        error
      });
      return [];
    });

    return analyzeMarket({
      symbol,
      ticker,
      candles,
      highTimeframeCandles,
      market,
      marketCap: cap,
      config: this.config
    });
  }

  async hasMinimumMarketAge(symbol) {
    const days = this.config.scanner.minMarketAgeDays;
    if (!days || days <= 0) return true;

    const market = this.exchange.cache.getMarket(symbol);
    const onboardDate = market && market.info && Number(market.info.onboardDate || market.info.launchTime || 0);
    if (onboardDate > 0) {
      const ageDays = (Date.now() - onboardDate) / (24 * 60 * 60 * 1000);
      return ageDays >= days;
    }

    try {
      const candles = await this.exchange.getOhlcv(symbol, '1d', days + 2);
      return (candles || []).length >= Math.min(days, days + 1);
    } catch (error) {
      this.logger.warn('Unable to verify market age; allowing symbol through age filter', {
        symbol,
        error
      });
      return true;
    }
  }
}

module.exports = MarketAnalyzer;
