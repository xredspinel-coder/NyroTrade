'use strict';

const axios = require('axios');
const cron = require('node-cron');

function everyMinutes(minutes) {
  const value = Math.max(1, Math.trunc(Number(minutes) || 1));
  if (value === 1) return '* * * * *';
  if (value >= 60) return '0 * * * *';
  return `*/${value} * * * *`;
}

class SchedulerService {
  constructor({
    exchange,
    scanner,
    sentiment,
    strategy,
    portfolio,
    storage,
    cache,
    config,
    logger
  }) {
    this.exchange = exchange;
    this.scanner = scanner;
    this.sentiment = sentiment;
    this.strategy = strategy;
    this.portfolio = portfolio;
    this.storage = storage;
    this.cache = cache;
    this.config = config;
    this.logger = logger;
    this.jobs = [];
    this.inFlight = new Set();
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;

    this.addJob('market-cache-refresh', everyMinutes(1), () => this.refreshMarketCache(), 55 * 1000);
    this.addJob('strategy-tick', everyMinutes(this.config.scheduler.strategyIntervalMinutes), () => this.strategy.runOnce(), 55 * 1000);
    this.addJob('volatility-scan', everyMinutes(this.config.scanner.volatilityScanIntervalMinutes), () => this.scanner.scanVolatile(), 14 * 60 * 1000);
    this.addJob('sentiment-refresh', everyMinutes(this.config.scheduler.sentimentRefreshMinutes), async () => {
      const watchlist = await this.scanner.getWatchlist();
      await this.sentiment.refresh(watchlist);
    }, 25 * 60 * 1000);
    this.addJob('cache-cleanup', everyMinutes(this.config.cache.cleanupMinutes), async () => {
      this.cache.cleanup();
    }, 5 * 60 * 1000);
    this.addJob('stale-data-cleanup', '17 * * * *', () => this.storage.cleanupStaleData(), 50 * 60 * 1000);
    this.addJob('portfolio-mark', everyMinutes(5), () => this.portfolio.getSnapshot(), 4 * 60 * 1000);

    if (this.config.scheduler.selfPing && this.config.telegram.webhookUrl) {
      this.addJob('self-ping', everyMinutes(this.config.scheduler.selfPingMinutes), () => this.selfPing(), 2 * 60 * 1000);
    }

    this.logger.system('Scheduler started', { jobs: this.jobs.length });
  }

  addJob(name, expression, task, lockTtlMs) {
    const job = cron.schedule(expression, () => {
      this.runLocked(name, lockTtlMs, task).catch((error) => {
        this.logger.error('Scheduled job failed', { name, error });
      });
    }, {
      scheduled: true,
      timezone: 'UTC'
    });
    this.jobs.push({ name, job });
  }

  async runLocked(name, lockTtlMs, task) {
    if (this.inFlight.has(name)) {
      this.logger.warn('Scheduled job skipped locally because it is already running', { name });
      return;
    }

    this.inFlight.add(name);
    let token = null;
    try {
      token = await this.storage.acquireLock(`scheduler:${name}`, lockTtlMs);
      if (!token) {
        this.logger.info('Scheduled job skipped because another instance owns the lock', { name });
        return;
      }

      await task();
    } finally {
      await this.storage.releaseLock(`scheduler:${name}`, token);
      this.inFlight.delete(name);
    }
  }

  async refreshMarketCache() {
    const watchlist = await this.scanner.getWatchlist();
    await this.exchange.refreshTickers();
    const positions = await this.storage.getOpenPositions();
    const activeSymbols = Array.from(new Set([...watchlist, ...positions.map((position) => position.symbol)]));
    const activeTickers = {};
    for (const symbol of activeSymbols) {
      const ticker = this.cache.getTicker(symbol, 0);
      if (ticker) activeTickers[symbol] = ticker;
    }
    await this.storage.updateLastKnownPrices(activeTickers);
  }

  async selfPing() {
    const url = `${this.config.telegram.webhookUrl}/health`;
    await axios.get(url, { timeout: 10000 });
    this.logger.info('Self ping complete', { url });
  }

  stop() {
    for (const { job } of this.jobs) {
      job.stop();
    }
    this.jobs = [];
    this.started = false;
    this.logger.system('Scheduler stopped');
  }
}

module.exports = SchedulerService;
