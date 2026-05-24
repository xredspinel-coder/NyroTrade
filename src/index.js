'use strict';

const crypto = require('crypto');
const http = require('http');
const config = require('./config');
const logger = require('./utils/logger');
const MarketCache = require('./utils/cache');
const { initializeFirebase } = require('./firebase');
const FirestoreStorage = require('./storage/firestore');
const ExchangeService = require('./services/exchange');
const BlacklistService = require('./services/blacklist');
const MarketCapService = require('./services/marketCap');
const MarketAnalyzer = require('./services/marketAnalyzer');
const ScannerService = require('./services/scanner');
const SentimentService = require('./services/sentiment');
const RiskService = require('./services/risk');
const PortfolioService = require('./services/portfolio');
const AlertService = require('./services/alerts');
const AnalyticsService = require('./services/analytics');
const MarketRegimeService = require('./services/marketRegime');
const TradingStrategy = require('./strategies/trading');
const HealthService = require('./services/health');
const TelegramService = require('./bot/telegram');
const SchedulerService = require('./scheduler/scheduler');
const { createServer } = require('./server');

function validateRuntimeConfig() {
  const missing = [];
  if (!config.telegram.token) missing.push('BOT_TOKEN');
  if (!config.telegram.chatId) missing.push('TELEGRAM_CHAT_ID');
  if (!config.telegram.webhookUrl) missing.push('WEBHOOK_URL');
  if (!config.telegram.webhookSecret) missing.push('TELEGRAM_WEBHOOK_SECRET');
  if (!config.firebase.projectId) missing.push('FIREBASE_PROJECT_ID');
  if (!config.firebase.clientEmail) missing.push('FIREBASE_CLIENT_EMAIL');
  if (!config.firebase.privateKey) missing.push('FIREBASE_PRIVATE_KEY');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

async function warmup({ storage, blacklist, exchange, scanner, sentiment, portfolio, telegram, alerts, marketRegime, analytics, state }) {
  logger.system('Starting NyroTrade warmup', { restartAt: config.lastRestartAt });
  await storage.ensureBootstrap();
  await blacklist.load();
  await portfolio.initialize();
  await exchange.loadMarkets();
  await exchange.refreshTickers();

  try {
    await scanner.scanVolatile({ force: true, limit: 50 });
  } catch (error) {
    logger.warn('Startup volatility scan failed; scheduler will retry', { error });
  }

  await marketRegime.refresh().catch((error) => {
    logger.warn('Startup market regime refresh failed; scheduler will retry', { error });
  });

  const activeTickers = {};
  for (const symbol of await scanner.getWatchlist()) {
    const ticker = exchange.cache.getTicker(symbol, 0);
    if (ticker) activeTickers[symbol] = ticker;
  }
  await storage.updateLastKnownPrices(activeTickers);

  try {
    const watchlist = await scanner.getWatchlist();
    await sentiment.refresh(watchlist);
  } catch (error) {
    logger.warn('Startup sentiment refresh failed; fallback sentiment remains neutral', { error });
  }

  await portfolio.getSnapshot();
  await analytics.refresh().catch((error) => {
    logger.warn('Startup analytics refresh failed; scheduler will retry', { error });
  });
  await telegram.configureWebhook();
  state.warmupComplete = true;
  logger.system('NyroTrade warmup complete');
  await alerts.sendSystem('Warmup complete. Paper trading monitor is active.', {
    restartAt: config.lastRestartAt
  }).catch((error) => logger.warn('Startup Telegram notice failed', { error }));
}

async function start() {
  validateRuntimeConfig();

  const state = {
    warmupComplete: false
  };
  const instanceId = `${crypto.randomUUID()}`;
  const db = initializeFirebase(config.firebase);
  const cache = new MarketCache({ config, logger });
  const storage = new FirestoreStorage({ db, config, logger, instanceId });
  const exchange = new ExchangeService({ config, cache, logger });
  const blacklist = new BlacklistService({ storage, logger });
  const marketCap = new MarketCapService({ logger });
  const analyzer = new MarketAnalyzer({ exchange, marketCap, config, logger });
  const scanner = new ScannerService({ exchange, analyzer, blacklist, storage, config, logger });
  const sentiment = new SentimentService({ storage, config, logger });
  const risk = new RiskService({ storage, blacklist, config });
  const portfolio = new PortfolioService({ storage, cache, config, logger });
  const alerts = new AlertService({ storage, config, logger });
  const marketRegime = new MarketRegimeService({ exchange, storage, config, logger });
  const analytics = new AnalyticsService({ storage, portfolio, config, logger });
  const strategy = new TradingStrategy({
    analyzer,
    risk,
    portfolio,
    sentiment,
    scanner,
    storage,
    exchange,
    alerts,
    marketRegime,
    config,
    logger
  });
  const health = new HealthService({ storage, cache, sentiment, scanner, analytics, marketRegime, config, logger, state });

  const services = {
    portfolio,
    scanner,
    health,
    storage,
    strategy,
    analytics,
    marketRegime
  };
  const telegram = new TelegramService({ config, services, logger });
  alerts.setTelegram(telegram);
  health.setTelegram(telegram);

  const app = createServer({ telegram, health });
  const server = http.createServer(app);
  const scheduler = new SchedulerService({
    exchange,
    scanner,
    sentiment,
    strategy,
    portfolio,
    storage,
    cache,
    analytics,
    marketRegime,
    config,
    logger
  });

  await new Promise((resolve) => {
    server.listen(config.port, () => {
      logger.system('HTTP server listening', { port: config.port });
      resolve();
    });
  });

  await warmup({
    storage,
    blacklist,
    exchange,
    scanner,
    sentiment,
    portfolio,
    telegram,
    alerts,
    marketRegime,
    analytics,
    state
  });

  scheduler.start();

  const shutdown = async (signal) => {
    logger.system('Shutdown requested', { signal });
    scheduler.stop();
    await new Promise((resolve) => server.close(resolve));
    logger.system('Shutdown complete');
  };

  process.once('SIGTERM', () => {
    shutdown('SIGTERM').finally(() => process.exit(0));
  });
  process.once('SIGINT', () => {
    shutdown('SIGINT').finally(() => process.exit(0));
  });

  return {
    server,
    scheduler,
    services: {
      storage,
      exchange,
      scanner,
      sentiment,
      portfolio,
      strategy,
      health,
      telegram,
      analytics,
      marketRegime
    }
  };
}

module.exports = {
  start
};
