'use strict';

const axios = require('axios');
const { withRetry } = require('../utils/retry');

class MarketCapService {
  constructor({ logger }) {
    this.logger = logger;
    this.cache = new Map();
    this.updatedAt = 0;
    this.ttlMs = 30 * 60 * 1000;
    this.refreshPromise = null;
  }

  async refresh() {
    if (Date.now() - this.updatedAt < this.ttlMs && this.cache.size > 0) {
      return this.cache;
    }
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      try {
        const response = await withRetry(
          () => axios.get('https://api.coingecko.com/api/v3/coins/markets', {
            params: {
              vs_currency: 'usd',
              order: 'market_cap_desc',
              per_page: 250,
              page: 1,
              sparkline: false
            },
            timeout: 15000
          }),
          {
            label: 'coingecko.marketCaps',
            retries: 2,
            timeoutMs: 18000,
            logger: this.logger
          }
        );

        const next = new Map();
        for (const coin of response.data || []) {
          const symbol = String(coin.symbol || '').toUpperCase();
          if (!symbol) continue;
          const current = next.get(symbol);
          const cap = Number(coin.market_cap || 0);
          if (!current || cap > current.marketCapUsd) {
            next.set(symbol, {
              id: coin.id,
              name: coin.name,
              marketCapUsd: cap,
              rank: coin.market_cap_rank || null
            });
          }
        }

        this.cache = next;
        this.updatedAt = Date.now();
        this.logger.info('Updated market cap cache', { count: this.cache.size });
      } catch (error) {
        this.logger.warn('Market cap lookup unavailable; scanner will continue without it', { error });
      } finally {
        this.refreshPromise = null;
      }
      return this.cache;
    })();

    return this.refreshPromise;
  }

  async getMarketCap(baseSymbol) {
    await this.refresh();
    return this.cache.get(String(baseSymbol || '').toUpperCase()) || null;
  }
}

module.exports = MarketCapService;
