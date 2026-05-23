'use strict';

const { toMillis } = require('./format');

class MarketCache {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.markets = new Map();
    this.tickers = new Map();
    this.ohlcv = new Map();
    this.metadata = {
      latestMarketUpdate: null,
      latestTickerUpdate: null,
      latestOhlcvUpdate: null
    };
  }

  setMarkets(markets) {
    this.markets.clear();
    const now = new Date();
    Object.values(markets || {}).forEach((market) => {
      if (market && market.symbol) {
        this.markets.set(market.symbol.toUpperCase(), {
          data: market,
          updatedAt: now
        });
      }
    });
    this.metadata.latestMarketUpdate = now.toISOString();
  }

  getMarkets() {
    return Array.from(this.markets.values()).map((entry) => entry.data);
  }

  getMarket(symbol) {
    const entry = this.markets.get(String(symbol || '').toUpperCase());
    return entry && entry.data;
  }

  isMarketsFresh() {
    if (!this.metadata.latestMarketUpdate) return false;
    return Date.now() - Date.parse(this.metadata.latestMarketUpdate) < this.config.cache.marketTtlMs;
  }

  setTickers(tickers) {
    const now = new Date();
    Object.entries(tickers || {}).forEach(([symbol, ticker]) => {
      if (ticker) {
        this.tickers.set(String(symbol).toUpperCase(), {
          data: ticker,
          updatedAt: now
        });
      }
    });
    this.metadata.latestTickerUpdate = now.toISOString();
  }

  setTicker(symbol, ticker) {
    const now = new Date();
    this.tickers.set(String(symbol).toUpperCase(), {
      data: ticker,
      updatedAt: now
    });
    this.metadata.latestTickerUpdate = now.toISOString();
  }

  getTicker(symbol, maxAgeMs = this.config.cache.tickerTtlMs) {
    const entry = this.tickers.get(String(symbol || '').toUpperCase());
    if (!entry) return null;
    if (maxAgeMs && Date.now() - toMillis(entry.updatedAt) > maxAgeMs) return null;
    return entry.data;
  }

  getAllTickers(maxAgeMs = 0) {
    const result = {};
    for (const [symbol, entry] of this.tickers.entries()) {
      if (!maxAgeMs || Date.now() - toMillis(entry.updatedAt) <= maxAgeMs) {
        result[symbol] = entry.data;
      }
    }
    return result;
  }

  setOhlcv(symbol, timeframe, candles, ttlMs = this.config.cache.ohlcvTtlMs) {
    const now = new Date();
    const key = this.ohlcvKey(symbol, timeframe);
    this.ohlcv.set(key, {
      data: candles || [],
      updatedAt: now,
      expiresAt: new Date(now.getTime() + ttlMs)
    });
    this.metadata.latestOhlcvUpdate = now.toISOString();
  }

  getOhlcv(symbol, timeframe) {
    const entry = this.ohlcv.get(this.ohlcvKey(symbol, timeframe));
    if (!entry) return null;
    if (Date.now() > toMillis(entry.expiresAt)) return null;
    return entry.data;
  }

  ohlcvKey(symbol, timeframe) {
    return `${String(symbol || '').toUpperCase()}::${timeframe}`;
  }

  cleanup() {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.ohlcv.entries()) {
      if (now > toMillis(entry.expiresAt)) {
        this.ohlcv.delete(key);
        removed += 1;
      }
    }

    const tickerMaxAge = this.config.cache.tickerTtlMs * 10;
    for (const [key, entry] of this.tickers.entries()) {
      if (now - toMillis(entry.updatedAt) > tickerMaxAge) {
        this.tickers.delete(key);
        removed += 1;
      }
    }

    if (removed > 0) {
      this.logger.info('Cache cleanup removed stale entries', { removed });
    }
    return removed;
  }

  size() {
    return {
      markets: this.markets.size,
      tickers: this.tickers.size,
      ohlcv: this.ohlcv.size
    };
  }

  getLatestMarketUpdate() {
    return this.metadata.latestTickerUpdate || this.metadata.latestMarketUpdate;
  }
}

module.exports = MarketCache;
