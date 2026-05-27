'use strict';

require('dotenv').config();

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

function toStringValue(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function toList(value, fallback = '') {
  return String(value || fallback)
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function normalizeBaseUrl(value) {
  const trimmed = toStringValue(value).trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

const baseSymbol = toStringValue(process.env.BASE_SYMBOL).trim().toUpperCase();
const port = toInteger(process.env.PORT);
const webhookUrl = normalizeBaseUrl(process.env.WEBHOOK_URL);

const config = {
  appName: 'NyroTrade',
  env: process.env.NODE_ENV,
  port,
  lastRestartAt: new Date().toISOString(),

  telegram: {
    token: toStringValue(process.env.BOT_TOKEN),
    chatId: toStringValue(process.env.TELEGRAM_CHAT_ID),
    webhookUrl,
    webhookPath: '/telegram/webhook',
    webhookSecret: toStringValue(process.env.TELEGRAM_WEBHOOK_SECRET),
    sendTimeoutMs: 10000,
    maxMessageLength: 3900
  },

  firebase: {
    projectId: toStringValue(process.env.FIREBASE_PROJECT_ID),
    privateKey: toStringValue(process.env.FIREBASE_PRIVATE_KEY),
    clientEmail: toStringValue(process.env.FIREBASE_CLIENT_EMAIL)
  },

  exchange: {
    id: 'binance',
    apiKey: toStringValue(process.env.BINANCE_API_KEY),
    secret: toStringValue(process.env.BINANCE_API_SECRET),
    baseSymbol,
    requestTimeoutMs: 15000,
    ohlcvTimeframe: '5m',
    ohlcvLimit: 72,
    higherTimeframe: process.env.HIGHER_TIMEFRAME,
    higherTimeframeLimit: toInteger(process.env.HIGHER_TIMEFRAME_LIMIT),
    marketReloadMinutes: 60
  },

  scanner: {
    memeMode: toBoolean(process.env.MEME_MODE),
    autoDiscoverVolatile: toBoolean(process.env.AUTO_DISCOVER_VOLATILE),
    initialWatchlist: toList(process.env.WATCHLIST),
    maxWatchlistSize: toInteger(process.env.MAX_WATCHLIST_SIZE),
    minQuoteVolumeUsdt: toNumber(process.env.MIN_QUOTE_VOLUME_USDT),
    volatilityScanIntervalMinutes: toInteger(process.env.VOLATILITY_SCAN_INTERVAL_MINUTES),
    minMarketAgeDays: toInteger(process.env.MIN_MARKET_AGE_DAYS),
    minMarketCapUsd: toNumber(process.env.MIN_MARKET_CAP_USD),
    candidateLimit: toInteger(process.env.SCANNER_CANDIDATE_LIMIT),
    maxSpread: toNumber(process.env.MAX_SPREAD),
    minVolatilityScore: toNumber(process.env.MIN_VOLATILITY_SCORE),
    minLiquidityScore: toNumber(process.env.MIN_LIQUIDITY_SCORE),
    abnormalPumpPercent: toNumber(process.env.ABNORMAL_PUMP_PERCENT),
    suspiciousSingleCandlePercent: toNumber(process.env.SUSPICIOUS_SINGLE_CANDLE_PERCENT)
  },

  risk: {
    paperStartBalance: toNumber(process.env.PAPER_START_BALANCE),
    maxTradeFraction: toNumber(process.env.MAX_TRADE_FRACTION),
    maxOpenPositions: toInteger(process.env.MAX_OPEN_POSITIONS),
    stopLoss: toNumber(process.env.STOP_LOSS),
    takeProfit: toNumber(process.env.TAKE_PROFIT),
    minBuyPriceChange: toNumber(process.env.MIN_BUY_PRICE_CHANGE),
    minVolumeRatio: toNumber(process.env.MIN_VOLUME_RATIO),
    maxPumpAlreadyMovedPercent: toNumber(process.env.MAX_PUMP_ALREADY_MOVED),
    alertCooldownMinutes: toInteger(process.env.ALERT_COOLDOWN_MINUTES),
    paperFeeRate: toNumber(process.env.PAPER_FEE_RATE),
    minTradeNotional: toNumber(process.env.MIN_TRADE_NOTIONAL),
    buyCooldownMinutes: toInteger(process.env.BUY_COOLDOWN_MINUTES),
    globalTradeCooldownMinutes: toInteger(process.env.GLOBAL_TRADE_COOLDOWN_MINUTES),
    symbolTradeCooldownMinutes: toInteger(process.env.SYMBOL_TRADE_COOLDOWN_MINUTES),
    sellVolatilityRankThreshold: toNumber(process.env.SELL_VOLATILITY_RANK_THRESHOLD),
    confirmationCandles: toInteger(process.env.CONFIRMATION_CANDLES),
    minBullishConfirmationCandles: toInteger(process.env.MIN_BULLISH_CONFIRMATION_CANDLES),
    minMomentumPersistence: toNumber(process.env.MIN_MOMENTUM_PERSISTENCE),
    minBreakoutPercent: toNumber(process.env.MIN_BREAKOUT_PERCENT),
    emaFastPeriod: toInteger(process.env.EMA_FAST_PERIOD),
    emaSlowPeriod: toInteger(process.env.EMA_SLOW_PERIOD),
    requireEmaTrend: toBoolean(process.env.REQUIRE_EMA_TREND),
    requireHigherTimeframeTrend: toBoolean(process.env.REQUIRE_HIGHER_TIMEFRAME_TREND),
    maxMemeExposurePct: toNumber(process.env.MAX_MEME_EXPOSURE_PCT),
    maxCategoryExposurePct: toNumber(process.env.MAX_CATEGORY_EXPOSURE_PCT),
    trailingStopPercent: toNumber(process.env.TRAILING_STOP_PERCENT),
    trailingStopActivationPct: toNumber(process.env.TRAILING_STOP_ACTIVATION_PCT),
    exitConfirmationCandles: toInteger(process.env.EXIT_CONFIRMATION_CANDLES),
    volatilityExitAtrMultiplier: toNumber(process.env.VOLATILITY_EXIT_ATR_MULTIPLIER),
    maxExtremeVolatilityScore: toNumber(process.env.MAX_EXTREME_VOLATILITY_SCORE),
    staleSignalMaxAgeMinutes: toInteger(process.env.STALE_SIGNAL_MAX_AGE_MINUTES),
    minStrategyHealthScore: toNumber(process.env.MIN_STRATEGY_HEALTH_SCORE),
    strategies: {
      degensniper: {
        maxTradeFraction: toNumber(process.env.DEGEN_SNIPER_MAX_TRADE_FRACTION),
        minOpportunityScore: toNumber(process.env.DEGEN_SNIPER_MIN_OPPORTUNITY_SCORE),
        maxSpread: toNumber(process.env.DEGEN_SNIPER_MAX_SPREAD),
        minVolumeAcceleration: toNumber(process.env.DEGEN_SNIPER_MIN_VOLUME_ACCELERATION),
        minMomentumAcceleration: toNumber(process.env.DEGEN_SNIPER_MIN_MOMENTUM_ACCELERATION),
        partialTakeProfit: toBoolean(process.env.DEGEN_SNIPER_PARTIAL_TAKE_PROFIT),
        trailingStop: toNumber(process.env.DEGEN_SNIPER_TRAILING_STOP)
      },
      whaleshadow: {
        whaleCredibilityMinScore: toNumber(process.env.WHALE_CREDIBILITY_MIN_SCORE)
      }
    }
  },

  degenSniper: {
    enabled: toBoolean(process.env.DEGEN_SNIPER_ENABLED),
    budget: toNumber(process.env.DEGEN_SNIPER_BUDGET),
    maxTradeFraction: toNumber(process.env.DEGEN_SNIPER_MAX_TRADE_FRACTION),
    minOpportunityScore: toNumber(process.env.DEGEN_SNIPER_MIN_OPPORTUNITY_SCORE),
    maxSpread: toNumber(process.env.DEGEN_SNIPER_MAX_SPREAD),
    minVolumeAcceleration: toNumber(process.env.DEGEN_SNIPER_MIN_VOLUME_ACCELERATION),
    minMomentumAcceleration: toNumber(process.env.DEGEN_SNIPER_MIN_MOMENTUM_ACCELERATION),
    partialTakeProfit: toBoolean(process.env.DEGEN_SNIPER_PARTIAL_TAKE_PROFIT),
    trailingStop: toNumber(process.env.DEGEN_SNIPER_TRAILING_STOP)
  },

  manualTrading: {
    enabled: toBoolean(process.env.MANUAL_TRADING_ENABLED),
    maxAmount: toNumber(process.env.MANUAL_TRADE_MAX_AMOUNT),
    confirmationRequired: toBoolean(process.env.MANUAL_TRADE_CONFIRMATION_REQUIRED)
  },

  whale: {
    credibilityMinScore: toNumber(process.env.WHALE_CREDIBILITY_MIN_SCORE),
    trackingEnabled: toBoolean(process.env.WHALE_TRACKING_ENABLED),
    exchangeWalletFilter: toBoolean(process.env.WHALE_EXCHANGE_WALLET_FILTER),
    marketMakerFilter: toBoolean(process.env.WHALE_MARKET_MAKER_FILTER)
  },

  cache: {
    tickerTtlMs: toInteger(process.env.CACHE_REFRESH_SECONDS) * 1000,
    ohlcvTtlMs: toInteger(process.env.OHLCV_CACHE_SECONDS) * 1000,
    marketTtlMs: toInteger(process.env.MARKET_CACHE_MINUTES) * 60 * 1000,
    cleanupMinutes: toInteger(process.env.CACHE_CLEANUP_MINUTES)
  },

  scheduler: {
    strategyIntervalMinutes: toInteger(process.env.STRATEGY_INTERVAL_MINUTES),
    sentimentRefreshMinutes: toInteger(process.env.SENTIMENT_REFRESH_MINUTES),
    analyticsRefreshMinutes: toInteger(process.env.ANALYTICS_REFRESH_MINUTES),
    regimeRefreshMinutes: toInteger(process.env.REGIME_REFRESH_MINUTES),
    selfPing: toBoolean(process.env.SELF_PING),
    selfPingMinutes: toInteger(process.env.SELF_PING_MINUTES)
  },

  sentiment: {
    ollamaUrl: normalizeBaseUrl(process.env.OLLAMA_URL),
    ollamaModel: process.env.OLLAMA_MODEL,
    timeoutMs: toInteger(process.env.SENTIMENT_TIMEOUT_MS),
    aiRankingEnabled: toBoolean(process.env.AI_RANKING_ENABLED),
    minSentimentConfidence: toNumber(process.env.MIN_SENTIMENT_CONFIDENCE),
    sources: [
      'https://www.coindesk.com/arc/outboundfeeds/rss/',
      'https://cointelegraph.com/rss',
      'https://cryptoslate.com/feed/'
    ]
  },

  storage: {
    staleAlertsDays: toInteger(process.env.STALE_ALERTS_DAYS),
    staleSentimentDays: toInteger(process.env.STALE_SENTIMENT_DAYS),
    staleRankingsDays: toInteger(process.env.STALE_RANKINGS_DAYS),
    stalePricesDays: toInteger(process.env.STALE_PRICES_DAYS),
    portfolioSnapshotMinSeconds: toInteger(process.env.PORTFOLIO_SNAPSHOT_MIN_SECONDS)
  }
};

config.telegram.fullWebhookUrl = config.telegram.webhookUrl
  ? `${config.telegram.webhookUrl}${config.telegram.webhookPath}`
  : '';

module.exports = config;
