'use strict';

require('dotenv').config();

const DEFAULT_WATCHLIST = 'DOGE/USDT,SHIB/USDT,PEPE/USDT,WIF/USDT,BONK/USDT,FLOKI/USDT,TURBO/USDT';

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toInteger(value, fallback) {
  const number = toNumber(value, fallback);
  return Math.trunc(number);
}

function toList(value, fallback = '') {
  return String(value || fallback)
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || '').trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

const baseSymbol = String(process.env.BASE_SYMBOL || 'USDT').trim().toUpperCase();
const port = toInteger(process.env.PORT, 3000);
const webhookUrl = normalizeBaseUrl(process.env.WEBHOOK_URL);

const config = {
  appName: 'NyroTrade',
  env: process.env.NODE_ENV || 'production',
  port,
  lastRestartAt: new Date().toISOString(),

  telegram: {
    token: process.env.BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    webhookUrl,
    webhookPath: '/telegram/webhook',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    sendTimeoutMs: 10000,
    maxMessageLength: 3900
  },

  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    privateKey: process.env.FIREBASE_PRIVATE_KEY || '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || ''
  },

  exchange: {
    id: 'binance',
    apiKey: process.env.BINANCE_API_KEY || '',
    secret: process.env.BINANCE_API_SECRET || '',
    baseSymbol,
    requestTimeoutMs: 15000,
    ohlcvTimeframe: '5m',
    ohlcvLimit: 48,
    marketReloadMinutes: 60
  },

  scanner: {
    memeMode: toBoolean(process.env.MEME_MODE, true),
    autoDiscoverVolatile: toBoolean(process.env.AUTO_DISCOVER_VOLATILE, true),
    initialWatchlist: toList(process.env.WATCHLIST, DEFAULT_WATCHLIST),
    maxWatchlistSize: toInteger(process.env.MAX_WATCHLIST_SIZE, 15),
    minQuoteVolumeUsdt: toNumber(process.env.MIN_QUOTE_VOLUME_USDT, 1000000),
    volatilityScanIntervalMinutes: toInteger(process.env.VOLATILITY_SCAN_INTERVAL_MINUTES, 15),
    minMarketAgeDays: toInteger(process.env.MIN_MARKET_AGE_DAYS, 7),
    minMarketCapUsd: toNumber(process.env.MIN_MARKET_CAP_USD, 0),
    candidateLimit: toInteger(process.env.SCANNER_CANDIDATE_LIMIT, 80),
    maxSpread: toNumber(process.env.MAX_SPREAD, 0.003),
    minVolatilityScore: toNumber(process.env.MIN_VOLATILITY_SCORE, 0.45)
  },

  risk: {
    paperStartBalance: toNumber(process.env.PAPER_START_BALANCE, 100),
    maxTradeFraction: toNumber(process.env.MAX_TRADE_FRACTION, 0.10),
    maxOpenPositions: toInteger(process.env.MAX_OPEN_POSITIONS, 4),
    stopLoss: toNumber(process.env.STOP_LOSS, -0.05),
    takeProfit: toNumber(process.env.TAKE_PROFIT, 0.08),
    minBuyPriceChange: toNumber(process.env.MIN_BUY_PRICE_CHANGE, 0.002),
    minVolumeRatio: toNumber(process.env.MIN_VOLUME_RATIO, 1),
    maxPumpAlreadyMovedPercent: toNumber(process.env.MAX_PUMP_ALREADY_MOVED, 40),
    alertCooldownMinutes: toInteger(process.env.ALERT_COOLDOWN_MINUTES, 30),
    paperFeeRate: toNumber(process.env.PAPER_FEE_RATE, 0.001),
    minTradeNotional: toNumber(process.env.MIN_TRADE_NOTIONAL, 5),
    buyCooldownMinutes: toInteger(process.env.BUY_COOLDOWN_MINUTES, 20),
    sellVolatilityRankThreshold: toNumber(process.env.SELL_VOLATILITY_RANK_THRESHOLD, 0.25)
  },

  cache: {
    tickerTtlMs: toInteger(process.env.CACHE_REFRESH_SECONDS, 60) * 1000,
    ohlcvTtlMs: toInteger(process.env.OHLCV_CACHE_SECONDS, 60) * 1000,
    marketTtlMs: toInteger(process.env.MARKET_CACHE_MINUTES, 60) * 60 * 1000,
    cleanupMinutes: toInteger(process.env.CACHE_CLEANUP_MINUTES, 10)
  },

  scheduler: {
    strategyIntervalMinutes: toInteger(process.env.STRATEGY_INTERVAL_MINUTES, 1),
    sentimentRefreshMinutes: toInteger(process.env.SENTIMENT_REFRESH_MINUTES, 30),
    selfPing: toBoolean(process.env.SELF_PING, true),
    selfPingMinutes: toInteger(process.env.SELF_PING_MINUTES, 5)
  },

  sentiment: {
    ollamaUrl: normalizeBaseUrl(process.env.OLLAMA_URL),
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3.1',
    timeoutMs: toInteger(process.env.SENTIMENT_TIMEOUT_MS, 15000),
    sources: [
      'https://www.coindesk.com/arc/outboundfeeds/rss/',
      'https://cointelegraph.com/rss',
      'https://cryptoslate.com/feed/'
    ]
  },

  storage: {
    staleAlertsDays: toInteger(process.env.STALE_ALERTS_DAYS, 14),
    staleSentimentDays: toInteger(process.env.STALE_SENTIMENT_DAYS, 14),
    staleRankingsDays: toInteger(process.env.STALE_RANKINGS_DAYS, 7),
    stalePricesDays: toInteger(process.env.STALE_PRICES_DAYS, 7)
  }
};

config.telegram.fullWebhookUrl = config.telegram.webhookUrl
  ? `${config.telegram.webhookUrl}${config.telegram.webhookPath}`
  : '';

module.exports = config;
