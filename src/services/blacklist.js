'use strict';

const { uniqueSymbols } = require('../utils/format');

const STABLE_BASES = new Set([
  'USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'USDD', 'GUSD',
  'EUR', 'GBP', 'TRY', 'BRL', 'AUD', 'USTC', 'AEUR', 'PYUSD'
]);

const DEAD_OR_UNWANTED_BASES = new Set([
  'VEN', 'BCC', 'BCHABC', 'BCHSV', 'ERD', 'NPXS', 'PAX', 'SUSD'
]);

const UNWANTED_PATTERNS = [
  /(^|\/)(UP|DOWN|BULL|BEAR)\//i,
  /(3L|3S|5L|5S)\//i
];

class BlacklistService {
  constructor({ storage, logger }) {
    this.storage = storage;
    this.logger = logger;
    this.custom = new Set();
  }

  async load() {
    const symbols = await this.storage.getCustomBlacklist();
    this.custom = new Set(uniqueSymbols(symbols));
    this.logger.system('Loaded custom blacklist', { count: this.custom.size });
  }

  async isBlacklisted(symbol, market = null) {
    const reason = this.getReason(symbol, market);
    return Boolean(reason);
  }

  getReason(symbol, market = null) {
    const normalized = String(symbol || '').toUpperCase();
    const base = String((market && market.base) || normalized.split('/')[0] || '').toUpperCase();

    if (this.custom.has(normalized)) return 'custom blacklist';
    if (STABLE_BASES.has(base)) return 'stablecoin base';
    if (DEAD_OR_UNWANTED_BASES.has(base)) return 'dead or migrated asset';
    if (UNWANTED_PATTERNS.some((pattern) => pattern.test(normalized))) return 'directional token pattern';
    if (market && market.active === false) return 'inactive market';
    if (market && market.info && market.info.status && market.info.status !== 'TRADING') return `market status ${market.info.status}`;

    return null;
  }
}

module.exports = BlacklistService;
