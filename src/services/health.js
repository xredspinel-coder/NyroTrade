'use strict';

class HealthService {
  constructor({ storage, cache, sentiment, scanner, analytics, marketRegime, config, logger, state }) {
    this.storage = storage;
    this.cache = cache;
    this.sentiment = sentiment;
    this.scanner = scanner;
    this.analytics = analytics;
    this.marketRegime = marketRegime;
    this.config = config;
    this.logger = logger;
    this.state = state;
    this.telegram = null;
  }

  setTelegram(telegram) {
    this.telegram = telegram;
  }

  async getStatus() {
    let firestore = 'ok';
    try {
      await this.storage.checkConnection();
    } catch (error) {
      firestore = 'error';
      this.logger.warn('Firestore health check failed', { error });
    }

    const [positions, watchlist, diagnostics, regime] = await Promise.all([
      this.storage.getOpenPositions().catch(() => []),
      this.scanner.getWatchlist().catch(() => []),
      this.storage.getStrategyDiagnostics().catch(() => null),
      this.marketRegime ? this.marketRegime.getCurrent().catch(() => null) : Promise.resolve(null)
    ]);

    return {
      name: this.config.appName,
      status: this.state.warmupComplete ? 'ok' : 'warming',
      paused: Boolean((await this.storage.getSettings().catch(() => ({}))).paused),
      uptimeSeconds: Math.floor(process.uptime()),
      firestore,
      webhook: this.telegram ? this.telegram.getWebhookStatus() : { configured: false },
      latestMarketUpdate: this.cache.getLatestMarketUpdate(),
      latestSentimentUpdate: this.sentiment.latestUpdate,
      openPositionsCount: positions.length,
      cacheSize: this.cache.size(),
      memoryUsage: process.memoryUsage(),
      activeWatchlist: watchlist,
      strategyHealthScore: diagnostics ? diagnostics.strategyHealthScore : null,
      marketRegime: regime ? regime.regime : null,
      marketAggressiveness: regime ? regime.aggressiveness : null,
      lastRestartTime: this.config.lastRestartAt
    };
  }
}

module.exports = HealthService;
