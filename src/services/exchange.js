'use strict';

const ccxt = require('ccxt');
const { withRetry } = require('../utils/retry');

class ExchangeService {
  constructor({ config, cache, logger }) {
    this.config = config;
    this.cache = cache;
    this.logger = logger;
    this.inFlight = new Map();
    this.client = new ccxt.binance({
      apiKey: config.exchange.apiKey || undefined,
      secret: config.exchange.secret || undefined,
      enableRateLimit: true,
      timeout: config.exchange.requestTimeoutMs,
      options: {
        defaultType: 'spot',
        adjustForTimeDifference: true
      }
    });
  }

  async singleFlight(key, task) {
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const promise = task().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  async loadMarkets(force = false) {
    if (!force && this.cache.isMarketsFresh()) {
      return this.cache.getMarkets();
    }

    return this.singleFlight('loadMarkets', async () => {
      const markets = await withRetry(
        () => this.client.loadMarkets(true),
        {
          label: 'binance.loadMarkets',
          retries: 3,
          timeoutMs: this.config.exchange.requestTimeoutMs,
          logger: this.logger
        }
      );
      this.cache.setMarkets(markets);
      this.logger.system('Loaded Binance spot markets', {
        count: Object.keys(markets || {}).length
      });
      return this.cache.getMarkets();
    });
  }

  async refreshTickers(symbols = null) {
    await this.loadMarkets();
    const key = symbols && symbols.length ? `tickers:${symbols.join(',')}` : 'tickers:all';
    return this.singleFlight(key, async () => {
      const tickers = await withRetry(
        () => symbols && symbols.length ? this.client.fetchTickers(symbols) : this.client.fetchTickers(),
        {
          label: 'binance.fetchTickers',
          retries: 3,
          timeoutMs: this.config.exchange.requestTimeoutMs,
          logger: this.logger
        }
      );
      this.cache.setTickers(tickers);
      return tickers;
    });
  }

  async getTicker(symbol) {
    const normalized = String(symbol || '').toUpperCase();
    const cached = this.cache.getTicker(normalized);
    if (cached) return cached;

    return this.singleFlight(`ticker:${normalized}`, async () => {
      const ticker = await withRetry(
        () => this.client.fetchTicker(normalized),
        {
          label: `binance.fetchTicker.${normalized}`,
          retries: 3,
          timeoutMs: this.config.exchange.requestTimeoutMs,
          logger: this.logger
        }
      );
      this.cache.setTicker(normalized, ticker);
      return ticker;
    });
  }

  async getTickers(symbols = null) {
    const cached = this.cache.getAllTickers(this.config.cache.tickerTtlMs);
    if (!symbols || symbols.length === 0) {
      if (Object.keys(cached).length > 0) return cached;
      return this.refreshTickers();
    }

    const missing = symbols.filter((symbol) => !cached[String(symbol).toUpperCase()]);
    if (missing.length > 0) {
      await this.refreshTickers(symbols);
    }

    return symbols.reduce((result, symbol) => {
      const normalized = String(symbol).toUpperCase();
      const ticker = this.cache.getTicker(normalized, 0);
      if (ticker) result[normalized] = ticker;
      return result;
    }, {});
  }

  async getOhlcv(symbol, timeframe = this.config.exchange.ohlcvTimeframe, limit = this.config.exchange.ohlcvLimit) {
    const normalized = String(symbol || '').toUpperCase();
    const cached = this.cache.getOhlcv(normalized, timeframe);
    if (cached) return cached;

    return this.singleFlight(`ohlcv:${normalized}:${timeframe}:${limit}`, async () => {
      const candles = await withRetry(
        () => this.client.fetchOHLCV(normalized, timeframe, undefined, limit),
        {
          label: `binance.fetchOHLCV.${normalized}.${timeframe}`,
          retries: 2,
          timeoutMs: this.config.exchange.requestTimeoutMs,
          logger: this.logger
        }
      );
      this.cache.setOhlcv(normalized, timeframe, candles);
      return candles;
    });
  }

  async getSpotUsdtMarkets() {
    await this.loadMarkets();
    return this.cache.getMarkets().filter((market) => {
      return market
        && market.spot
        && market.active !== false
        && String(market.quote || '').toUpperCase() === this.config.exchange.baseSymbol;
    });
  }

  getSpread(ticker) {
    const bid = Number(ticker && ticker.bid);
    const ask = Number(ticker && ticker.ask);
    if (!bid || !ask || ask <= bid) return null;
    const mid = (bid + ask) / 2;
    return (ask - bid) / mid;
  }
}

module.exports = ExchangeService;
