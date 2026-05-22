require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');
const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');

// =============================
// NyroTrade - Telegram Crypto Paper Trading Bot
// Webhook mode + volatile/meme scanner + JSON storage
// Paper trading only. No real orders. No createOrder. No withdrawals.
// =============================

const CONFIG = {
  botToken: process.env.BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  webhookUrl: cleanUrl(process.env.WEBHOOK_URL || ''),
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  port: Number(process.env.PORT || 3000),

  baseSymbol: process.env.BASE_SYMBOL || 'USDT',
  paperStartBalance: Number(process.env.PAPER_START_BALANCE || 100),

  memeMode: String(process.env.MEME_MODE || 'true').toLowerCase() === 'true',
  autoDiscoverVolatile: String(process.env.AUTO_DISCOVER_VOLATILE || 'true').toLowerCase() === 'true',
  maxWatchlistSize: Number(process.env.MAX_WATCHLIST_SIZE || 15),
  minQuoteVolume: Number(process.env.MIN_QUOTE_VOLUME_USDT || 1000000),
  volatilityScanIntervalMinutes: Number(process.env.VOLATILITY_SCAN_INTERVAL_MINUTES || 15),

  ollamaUrl: cleanUrl(process.env.OLLAMA_URL || ''),
  ollamaModel: process.env.OLLAMA_MODEL || 'llama3.1',

  maxTradeFraction: Number(process.env.MAX_TRADE_FRACTION || 0.10),
  maxOpenPositions: Number(process.env.MAX_OPEN_POSITIONS || 4),
  stopLoss: Number(process.env.STOP_LOSS || -0.05),
  takeProfit: Number(process.env.TAKE_PROFIT || 0.08),

  minBuyPriceChange: Number(process.env.MIN_BUY_PRICE_CHANGE || 0.005),
  minVolumeRatio: Number(process.env.MIN_VOLUME_RATIO || 1.3),
  maxPumpAlreadyMoved: Number(process.env.MAX_PUMP_ALREADY_MOVED || 40),

  alertCooldownMinutes: Number(process.env.ALERT_COOLDOWN_MINUTES || 30),
  dataFile: process.env.DATA_FILE || path.join(__dirname, 'nyrotrade-data.json')
};

const DEFAULT_MEME_WATCHLIST = [
  'DOGE/USDT', 'SHIB/USDT', 'PEPE/USDT', 'WIF/USDT', 'BONK/USDT',
  'FLOKI/USDT', 'TURBO/USDT', 'MEME/USDT', 'BOME/USDT', 'NEIRO/USDT',
  'ACT/USDT', 'PNUT/USDT'
];

const STABLE_BASES = new Set(['USDT', 'USDC', 'FDUSD', 'TUSD', 'DAI', 'BUSD', 'USDP', 'EUR', 'TRY', 'BRL']);
const MEME_BASES = new Set(['DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'TURBO', 'MEME', 'BOME', 'BABYDOGE', 'PONKE', 'BRETT', 'NEIRO', 'ACT', 'PNUT', 'DOGS', 'CATI', 'MEW']);
const NEWS_SOURCES = [
  'https://cointelegraph.com/rss',
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://cryptopotato.com/feed/'
];

const STARTED_AT = Date.now();
let marketJobRunning = false;
let newsJobRunning = false;
let reportJobRunning = false;
let scanJobRunning = false;
let monitoringPaused = false;
let bot = null;
let exchange = null;
let lastAlertAt = new Map();

const db = loadDb();
initializeDb();

let watchlist = parseWatchlist(process.env.WATCHLIST || db.settings.watchlist || DEFAULT_MEME_WATCHLIST.join(','));
let latestSentiment = db.latestSentiment || { label: 'neutral', score: 0, items: [], updatedAt: null };
let topVolatile = db.topVolatile || [];
monitoringPaused = Boolean(db.settings.paused);

async function main() {
  exchange = new ccxt.binance({
    apiKey: process.env.BINANCE_API_KEY || undefined,
    secret: process.env.BINANCE_API_SECRET || undefined,
    enableRateLimit: true,
    timeout: 15000
  });

  if (!CONFIG.botToken) {
    console.warn('BOT_TOKEN missing. Telegram features disabled. Market jobs still run.');
  } else {
    bot = new TelegramBot(CONFIG.botToken, { polling: false });
    registerTelegramCommands();
  }

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/', (req, res) => {
    res.send('NyroTrade is running');
  });

  app.get('/health', (req, res) => {
    const lastPriceAt = getLastPriceTimestamp();
    res.json({
      status: 'ok',
      webhookMode: true,
      webhookUrlConfigured: Boolean(CONFIG.webhookUrl),
      uptime: formatDuration(Date.now() - STARTED_AT),
      paused: monitoringPaused,
      memeMode: CONFIG.memeMode,
      autoDiscoverVolatile: CONFIG.autoDiscoverVolatile,
      watchlist,
      topVolatile: topVolatile.slice(0, 5),
      cash: round2(db.paper.cash),
      portfolioValue: round2(getPortfolioValue().total),
      openPositions: db.positions.filter(p => p.status === 'open').length,
      priceRows: db.marketPrices.length,
      lastPriceAt: lastPriceAt ? new Date(lastPriceAt).toISOString() : null
    });
  });

  app.post('/telegram-webhook', (req, res) => {
    if (CONFIG.webhookSecret) {
      const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
      if (incomingSecret !== CONFIG.webhookSecret) {
        return res.sendStatus(403);
      }
    }

    if (!bot) return res.sendStatus(200);

    try {
      bot.processUpdate(req.body);
      return res.sendStatus(200);
    } catch (error) {
      console.error('Webhook processing failed:', error.message);
      return res.sendStatus(200);
    }
  });

  app.listen(CONFIG.port, async () => {
    console.log(`Express listening on port ${CONFIG.port}`);
    await setupWebhook();
    startCronJobs();
    runWarmup();
  });
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  safeSendMessage(`Bot recovered from unexpected error: ${escapeHtml(error.message || 'unknown')}`);
});

async function setupWebhook() {
  if (!bot || !CONFIG.webhookUrl) {
    console.warn('WEBHOOK_URL missing or bot disabled. Webhook will not be registered.');
    return;
  }

  const webhookEndpoint = `${CONFIG.webhookUrl}/telegram-webhook`;

  try {
    await bot.deleteWebHook({ drop_pending_updates: false });

    const options = CONFIG.webhookSecret
      ? { secret_token: CONFIG.webhookSecret }
      : undefined;

    await bot.setWebHook(webhookEndpoint, options);
    console.log(`Telegram webhook set: ${webhookEndpoint}`);
  } catch (error) {
    console.error('Failed to set Telegram webhook:', error.message);
  }
}

function startCronJobs() {
  cron.schedule('*/5 * * * *', guardedMarketMonitor);
  cron.schedule('*/30 * * * *', guardedNewsSentiment);
  cron.schedule('0 * * * *', guardedHourlyReport);

  const scanEvery = Math.max(5, CONFIG.volatilityScanIntervalMinutes);
  cron.schedule(`*/${scanEvery} * * * *`, guardedVolatilityScan);

  console.log(`Jobs started: market 5m, news 30m, report hourly, volatility ${scanEvery}m.`);
}

async function runWarmup() {
  await sleep(1500);

  if (CONFIG.autoDiscoverVolatile) {
    await guardedVolatilityScan();
  }

  await guardedMarketMonitor();
  await guardedNewsSentiment();
  await safeSendMessage('NyroTrade started. Paper trading only. No real trades.');
}

function registerTelegramCommands() {
  bot.onText(/^\/start$/, async (msg) => {
    if (!isAllowedChat(msg)) return;
    await safeSendMessage([
      '<b>NyroTrade</b>',
      'Crypto meme/volatile paper trading assistant.',
      '',
      '<b>Important:</b> this bot never places real trades. It only simulates paper trades.',
      '',
      '/status - portfolio status',
      '/report - hourly style report now',
      '/watchlist - active symbols',
      '/setwatchlist DOGE/USDT PEPE/USDT WIF/USDT - manual list',
      '/scanvolatile - scan Binance volatile USDT pairs',
      '/topvolatile - show discovered volatile coins',
      '/trades - recent paper trades',
      '/resetpaper - reset fake balance and trades',
      '/pause - pause monitoring',
      '/resume - resume monitoring'
    ].join('\n'));
  });

  bot.onText(/^\/status$/, async (msg) => {
    if (!isAllowedChat(msg)) return;
    await safeSendMessage(buildStatusMessage());
  });

  bot.onText(/^\/report$/, async (msg) => {
    if (!isAllowedChat(msg)) return;
    await safeSendMessage(buildHourlyReport());
  });

  bot.onText(/^\/watchlist$/, async (msg) => {
    if (!isAllowedChat(msg)) return;
    await safeSendMessage([
      '<b>Active Watchlist</b>',
      `Mode: ${CONFIG.autoDiscoverVolatile ? 'auto volatile discovery' : 'manual'}`,
      `Meme mode: ${CONFIG.memeMode ? 'ON' : 'OFF'}`,
      '',
      ...watchlist.map(s => `• ${s}`)
    ].join('\n'));
  });

  bot.onText(/^\/setwatchlist(?:\s+(.+))?$/, async (msg, match) => {
    if (!isAllowedChat(msg)) return;
    const symbols = parseWatchlist(match[1] || '');
    if (!symbols.length) {
      await safeSendMessage('Usage: /setwatchlist DOGE/USDT PEPE/USDT WIF/USDT');
      return;
    }
    watchlist = symbols.slice(0, CONFIG.maxWatchlistSize);
    db.settings.watchlist = watchlist.join(',');
    db.settings.manualWatchlist = true;
    saveDb();
    await safeSendMessage(`<b>Watchlist updated</b>\n${watchlist.map(s => `• ${s}`).join('\n')}`);
  });

  bot.onText(/^\/scanvolatile$/, async (msg) => {
    if (!isAllowedChat(msg)) return;
    await safeSendMessage('Scanning volatile USDT pairs...');
    await guardedVolatilityScan(true);
    await safeSendMessage(buildTopVolatileMessage());
  });

  bot.onText(/^\/topvolatile$/, async (msg) => {
    if (!isAllowedChat(msg)) return;
    await safeSendMessage(buildTopVolatileMessage());
  });

  bot.onText(/^\/trades$/, async (msg) => {
    if (!isAllowedChat(msg)) return;
    await safeSendMessage(buildTradesMessage());
  });

  bot.onText(/^\/resetpaper$/, async (msg) => {
    if (!isAllowedChat(msg)) return;
    resetPaperTrading();
    await safeSendMessage(`Paper trading reset to ${round2(CONFIG.paperStartBalance)} ${CONFIG.baseSymbol}.`);
  });

  bot.onText(/^\/pause$/, async (msg) => {
    if (!isAllowedChat(msg)) return;
    monitoringPaused = true;
    db.settings.paused = true;
    saveDb();
    await safeSendMessage('Monitoring paused.');
  });

  bot.onText(/^\/resume$/, async (msg) => {
    if (!isAllowedChat(msg)) return;
    monitoringPaused = false;
    db.settings.paused = false;
    saveDb();
    await safeSendMessage('Monitoring resumed.');
  });

  bot.on('webhook_error', (error) => console.error('Telegram webhook error:', error.message));
}

async function guardedMarketMonitor() {
  if (monitoringPaused || marketJobRunning) return;
  marketJobRunning = true;
  try {
    await monitorMarkets();
  } catch (error) {
    console.error('Market monitor failed:', error.message);
  } finally {
    marketJobRunning = false;
  }
}

async function guardedNewsSentiment() {
  if (monitoringPaused || newsJobRunning) return;
  newsJobRunning = true;
  try {
    latestSentiment = await fetchAndAnalyzeNews();
    db.latestSentiment = latestSentiment;
    saveDb();
  } catch (error) {
    console.error('News sentiment failed:', error.message);
  } finally {
    newsJobRunning = false;
  }
}

async function guardedHourlyReport() {
  if (monitoringPaused || reportJobRunning) return;
  reportJobRunning = true;
  try {
    await safeSendMessage(buildHourlyReport());
  } catch (error) {
    console.error('Hourly report failed:', error.message);
  } finally {
    reportJobRunning = false;
  }
}

async function guardedVolatilityScan(manual = false) {
  if (monitoringPaused || scanJobRunning) return;
  scanJobRunning = true;
  try {
    await scanVolatileSymbols(manual);
  } catch (error) {
    console.error('Volatility scan failed:', error.message);
  } finally {
    scanJobRunning = false;
  }
}

async function scanVolatileSymbols(manual = false) {
  console.log('Scanning volatile symbols...');

  const tickers = await withRetry(() => exchange.fetchTickers(), 2, 1500);
  const rows = [];

  for (const [symbol, ticker] of Object.entries(tickers || {})) {
    if (!symbol.endsWith(`/${CONFIG.baseSymbol}`)) continue;
    const base = symbol.split('/')[0].toUpperCase();
    if (STABLE_BASES.has(base)) continue;

    const quoteVolume = Number(ticker.quoteVolume || 0);
    const percentage = Number(ticker.percentage || 0);
    const last = Number(ticker.last || 0);

    if (!last || quoteVolume < CONFIG.minQuoteVolume) continue;

    const memeBonus = MEME_BASES.has(base) ? 12 : 0;
    const volatilityScore = Math.abs(percentage) + memeBonus + volumeBonus(quoteVolume);

    if (MEME_BASES.has(base) || Math.abs(percentage) >= 8) {
      rows.push({ symbol, base, percentage, quoteVolume, last, score: volatilityScore });
    }
  }

  rows.sort((a, b) => b.score - a.score);
  topVolatile = rows.slice(0, Math.max(CONFIG.maxWatchlistSize, 10));
  db.topVolatile = topVolatile;

  if (CONFIG.autoDiscoverVolatile || manual) {
    const discovered = topVolatile.slice(0, CONFIG.maxWatchlistSize).map(item => item.symbol);
    if (discovered.length) {
      watchlist = discovered;
      db.settings.watchlist = watchlist.join(',');
      db.settings.lastVolatilityScanAt = Date.now();
      console.log(`Watchlist auto-updated: ${watchlist.join(', ')}`);
    }
  }

  saveDb();
}

function volumeBonus(quoteVolume) {
  if (quoteVolume >= 100000000) return 10;
  if (quoteVolume >= 50000000) return 7;
  if (quoteVolume >= 10000000) return 4;
  if (quoteVolume >= 3000000) return 2;
  return 0;
}

async function monitorMarkets() {
  if (!watchlist.length) watchlist = DEFAULT_MEME_WATCHLIST;

  console.log(`Fetching market data for ${watchlist.join(', ')}`);
  const tickers = await fetchTickers(watchlist);
  const now = Date.now();
  const signals = [];

  for (const symbol of watchlist) {
    const ticker = tickers[symbol];
    if (!ticker || !ticker.last) {
      console.log(`Skip ${symbol}: no ticker data`);
      continue;
    }

    const price = Number(ticker.last);
    const volume = Number(ticker.quoteVolume || ticker.baseVolume || 0);
    const percentage = Number(ticker.percentage || 0);

    const signal = detectSignal(symbol, price, volume, percentage, now);
    signals.push(signal);
    insertMarketPrice({ symbol, price, volume, percentage, timestamp: now });

    if (signal.strong) await maybeSendSignalAlert(signal);
  }

  await runPaperTrading(signals);
  trimDb();
  saveDb();
}

async function fetchTickers(symbols) {
  return withRetry(async () => {
    const result = {};
    try {
      const tickers = await exchange.fetchTickers(symbols);
      for (const symbol of symbols) result[symbol] = tickers[symbol];
    } catch (error) {
      console.warn('Bulk fetch failed, trying one by one:', error.message);
      for (const symbol of symbols) {
        try {
          result[symbol] = await exchange.fetchTicker(symbol);
        } catch (innerError) {
          console.error(`Fetch failed for ${symbol}:`, innerError.message);
        }
      }
    }
    return result;
  }, 2, 1000);
}

function detectSignal(symbol, price, volume, percentage, timestamp) {
  const history = db.marketPrices.filter(p => p.symbol === symbol).slice(-20);
  const previous = history[history.length - 1];
  const priceChange = previous && previous.price ? (price - previous.price) / previous.price : percentage / 100;

  const recentVolumes = history.slice(-12).map(p => Number(p.volume || 0)).filter(Boolean);
  const avgVolume = recentVolumes.length ? average(recentVolumes) : volume;
  const volumeRatio = avgVolume > 0 ? volume / avgVolume : 1;

  const pump = priceChange >= 0.018;
  const dump = priceChange <= -0.018;
  const volumeSpike = volumeRatio >= CONFIG.minVolumeRatio;
  const strong = (pump || dump) && volumeSpike;
  const direction = pump ? 'pump' : dump ? 'dump' : priceChange > 0 ? 'up' : priceChange < 0 ? 'down' : 'flat';
  const strength = Math.abs(priceChange * 100) + Math.max(0, volumeRatio - 1) * 3;

  return { symbol, price, volume, percentage, priceChange, volumeRatio, volumeSpike, strong, direction, strength, timestamp };
}

async function maybeSendSignalAlert(signal) {
  const key = `${signal.symbol}:${signal.direction}`;
  const last = lastAlertAt.get(key) || 0;
  const cooldown = CONFIG.alertCooldownMinutes * 60 * 1000;
  if (Date.now() - last < cooldown) return;

  const message = [
    '<b>Strong Volatile Signal</b>',
    `${signal.symbol}: ${signal.direction.toUpperCase()}`,
    `Price: ${formatMoney(signal.price)}`,
    `Short move: ${formatPercent(signal.priceChange)}`,
    `Volume: ${round2(signal.volumeRatio)}x average`,
    'Paper trading only.'
  ].join('\n');

  db.alerts.push({ symbol: signal.symbol, message, strength: signal.strength, timestamp: signal.timestamp });
  lastAlertAt.set(key, Date.now());
  await safeSendMessage(message);
}

async function fetchAndAnalyzeNews() {
  console.log('Fetching crypto news sentiment');
  const articles = [];

  for (const sourceUrl of NEWS_SOURCES) {
    try {
      const response = await axios.get(sourceUrl, { timeout: 12000, headers: { 'User-Agent': 'nyrotrade/1.0' } });
      articles.push(...parseRss(response.data, sourceUrl));
    } catch (error) {
      console.warn(`News failed ${sourceUrl}:`, error.message);
    }
  }

  const unique = dedupeArticles(articles).slice(0, 20);
  const analyzed = [];

  for (const article of unique) {
    const analysis = await analyzeHeadline(article.title);
    const symbols = matchSymbolsForHeadline(article.title);
    const item = { ...article, ...analysis, symbols, timestamp: Date.now() };
    analyzed.push(item);
    db.sentimentItems.push(item);
  }

  const score = analyzed.reduce((sum, item) => sum + Number(item.score || 0), 0);
  const label = score > 1.5 ? 'bullish' : score < -1.5 ? 'bearish' : 'neutral';

  return { label, score, items: analyzed, updatedAt: Date.now() };
}

async function analyzeHeadline(title) {
  if (CONFIG.ollamaUrl) {
    try {
      const response = await axios.post(`${CONFIG.ollamaUrl}/api/generate`, {
        model: CONFIG.ollamaModel,
        prompt: `Classify this crypto headline as bullish, bearish, or neutral. Return JSON only: {"label":"bullish|bearish|neutral","score":-2 to 2}. Headline: ${title}`,
        stream: false
      }, { timeout: 20000 });

      const parsed = parseJsonLoose(response.data && response.data.response);
      if (parsed && parsed.label) return normalizeSentiment(parsed.label, Number(parsed.score || 0));
    } catch (error) {
      console.warn('Ollama failed, using rule sentiment:', error.message);
    }
  }

  return ruleBasedSentiment(title);
}

function ruleBasedSentiment(text) {
  const lower = String(text || '').toLowerCase();
  const bullish = ['surge', 'rally', 'gain', 'breakout', 'bull', 'approve', 'inflow', 'record', 'partnership', 'adoption', 'upgrade', 'recover', 'jumps', 'soars'];
  const bearish = ['drop', 'dump', 'fall', 'crash', 'bear', 'hack', 'lawsuit', 'outflow', 'ban', 'exploit', 'liquidation', 'plunge', 'selloff', 'fraud'];
  let score = 0;
  for (const word of bullish) if (lower.includes(word)) score += 1;
  for (const word of bearish) if (lower.includes(word)) score -= 1;
  return normalizeSentiment(score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral', clamp(score, -2, 2));
}

async function runPaperTrading(signals) {
  closePositionsIfNeeded(signals);
  openPositionsIfNeeded(signals);
}

function closePositionsIfNeeded(signals) {
  for (const position of db.positions.filter(p => p.status === 'open')) {
    const signal = signals.find(s => s.symbol === position.symbol);
    if (!signal) continue;

    const pnlPct = (signal.price - position.entryPrice) / position.entryPrice;
    const bearish = isBearishForSymbol(position.symbol);
    const reversal = signal.priceChange < -0.01 && signal.volumeSpike;
    const lostRank = lostVolatilityRank(position.symbol);

    if (pnlPct <= CONFIG.stopLoss) closePosition(position, signal.price, 'stop loss');
    else if (pnlPct >= CONFIG.takeProfit) closePosition(position, signal.price, 'take profit');
    else if (bearish) closePosition(position, signal.price, 'bearish sentiment');
    else if (reversal) closePosition(position, signal.price, 'momentum reversal');
    else if (lostRank) closePosition(position, signal.price, 'lost volatility rank');
  }
}

function openPositionsIfNeeded(signals) {
  const sorted = signals.slice().sort((a, b) => b.strength - a.strength);

  for (const signal of sorted) {
    const openCount = db.positions.filter(p => p.status === 'open').length;
    if (openCount >= CONFIG.maxOpenPositions) break;

    const reason = getBuyFailureReason(signal);
    if (reason) {
      console.log(`Skip BUY ${signal.symbol}: ${reason}`);
      continue;
    }

    openPosition(signal.symbol, signal.price, 'volatile momentum + volume + acceptable sentiment');
  }
}

function getBuyFailureReason(signal) {
  if (hasOpenPosition(signal.symbol)) return 'already open';
  if (!watchlist.includes(signal.symbol)) return 'not in watchlist';

  const sentimentOk = isBullishForSymbol(signal.symbol) || latestSentiment.label === 'neutral' || !latestSentiment.updatedAt;
  if (!sentimentOk) return `sentiment ${latestSentiment.label}`;

  if (signal.priceChange < CONFIG.minBuyPriceChange) return `priceChange too low ${formatPercent(signal.priceChange)}`;
  if (signal.volumeRatio < CONFIG.minVolumeRatio) return `volumeRatio too low ${round2(signal.volumeRatio)}x`;

  const movedTooMuch = Number(signal.percentage || 0) > CONFIG.maxPumpAlreadyMoved;
  const hugeVolume = Number(signal.volume || 0) >= CONFIG.minQuoteVolume * 20;
  if (movedTooMuch && !hugeVolume) return `24h pump too high ${round2(signal.percentage)}%`;

  if (db.paper.cash < 1) return 'cash too low';
  return '';
}

function openPosition(symbol, price, reason) {
  const amount = Math.min(db.paper.cash * CONFIG.maxTradeFraction, db.paper.cash);
  if (amount < 1) return;

  const quantity = amount / price;
  db.paper.cash -= amount;

  const position = {
    id: nextId('position'),
    symbol,
    entryPrice: price,
    quantity,
    invested: amount,
    openedAt: Date.now(),
    status: 'open'
  };

  db.positions.push(position);
  insertTrade(symbol, 'BUY', price, quantity, amount, 0, reason);
  console.log(`Paper BUY ${symbol}: ${round2(amount)} at ${price}`);
}

function closePosition(position, price, reason) {
  if (position.status !== 'open') return;

  const amount = position.quantity * price;
  const pnl = amount - position.invested;
  db.paper.cash += amount;
  position.status = 'closed';
  position.closedAt = Date.now();
  position.exitPrice = price;
  position.pnl = pnl;
  position.closeReason = reason;

  insertTrade(position.symbol, 'SELL', price, position.quantity, amount, pnl, reason);
  console.log(`Paper SELL ${position.symbol}: P/L ${round2(pnl)} reason=${reason}`);
}

function resetPaperTrading() {
  db.paper.cash = CONFIG.paperStartBalance;
  db.positions = [];
  db.trades = [];
  saveDb();
}

function buildStatusMessage() {
  const value = getPortfolioValue();
  const openPositions = db.positions.filter(p => p.status === 'open');

  const lines = [
    '<b>Paper Portfolio Status</b>',
    `Cash: ${round2(value.cash)} ${CONFIG.baseSymbol}`,
    `Open value: ${round2(value.openValue)} ${CONFIG.baseSymbol}`,
    `Portfolio: ${round2(value.total)} ${CONFIG.baseSymbol}`,
    `Total P/L: ${formatSignedMoney(value.total - CONFIG.paperStartBalance)} ${CONFIG.baseSymbol}`,
    `Price samples: ${db.marketPrices.length}`,
    ''
  ];

  if (!openPositions.length) {
    lines.push('Open positions: none');
  } else {
    lines.push('<b>Open Positions</b>');
    for (const p of openPositions) {
      const last = getLastPrice(p.symbol) || p.entryPrice;
      const pnlPct = (last - p.entryPrice) / p.entryPrice;
      lines.push(`${p.symbol}: ${round6(p.quantity)} @ ${formatMoney(p.entryPrice)} (${formatPercent(pnlPct)})`);
    }
  }

  return lines.join('\n');
}

function buildHourlyReport() {
  const value = getPortfolioValue();
  const movers = getBestWorstMovers();
  const strongest = getStrongestRecentSignal();
  const closedTrades = getClosedTradesSince(Date.now() - 60 * 60 * 1000);
  const openPositions = db.positions.filter(p => p.status === 'open');
  const lastPriceAt = getLastPriceTimestamp();
  const uptime = Date.now() - STARTED_AT;
  const restartNote = uptime < 15 * 60 * 1000 ? 'recent restart likely' : 'stable this session';

  return [
    '<b>Hourly Paper Trading Report</b>',
    `Cash: ${round2(value.cash)} ${CONFIG.baseSymbol}`,
    `Portfolio: ${round2(value.total)} ${CONFIG.baseSymbol} (${formatSignedMoney(value.total - CONFIG.paperStartBalance)} P/L)`,
    `Open positions: ${openPositions.length ? openPositions.map(p => p.symbol).join(', ') : 'none'}`,
    `Closed last hour: ${closedTrades.length}`,
    `Best watched: ${movers.best ? `${movers.best.symbol} ${formatPercent(movers.best.change)}` : 'n/a - not enough price samples yet'}`,
    `Worst watched: ${movers.worst ? `${movers.worst.symbol} ${formatPercent(movers.worst.change)}` : 'n/a - not enough price samples yet'}`,
    `Strongest signal: ${strongest ? `${strongest.symbol} strength ${round2(strongest.strength)}` : 'none'}`,
    `Sentiment: ${buildSentimentSummary()}`,
    `Meme mode: ${CONFIG.memeMode ? 'ON' : 'OFF'}`,
    `Auto volatile scan: ${CONFIG.autoDiscoverVolatile ? 'ON' : 'OFF'}`,
    `Top volatile: ${topVolatile.slice(0, 5).map(x => `${x.symbol} ${round2(x.percentage)}%`).join(', ') || 'none yet'}`,
    `Price rows: ${db.marketPrices.length}`,
    `Last price update: ${lastPriceAt ? formatTime(lastPriceAt) : 'none yet'}`,
    `Uptime: ${formatDuration(uptime)} (${restartNote})`,
    'Warning: paper trading only, no real trades.',
    `Next action: ${monitoringPaused ? 'paused' : 'continue monitoring volatile coins'}`
  ].join('\n');
}

function buildTradesMessage() {
  const trades = db.trades.slice(-10).reverse();
  if (!trades.length) return 'No simulated trades yet.';

  return [
    '<b>Last Simulated Trades</b>',
    ...trades.map(t => `${formatTime(t.timestamp)} ${t.side} ${t.symbol} ${round2(t.amount)} ${CONFIG.baseSymbol} P/L ${formatSignedMoney(t.pnl)} (${t.reason})`)
  ].join('\n');
}

function buildTopVolatileMessage() {
  if (!topVolatile.length) return 'No volatile symbols discovered yet. Try again after a few minutes.';

  return [
    '<b>Top Volatile Coins</b>',
    ...topVolatile.slice(0, 10).map((x, i) => `${i + 1}. ${x.symbol} | 24h ${round2(x.percentage)}% | vol ${formatCompact(x.quoteVolume)} | score ${round2(x.score)}`),
    '',
    `<b>Active watchlist:</b> ${watchlist.join(', ')}`
  ].join('\n');
}

function loadDb() {
  try {
    if (fs.existsSync(CONFIG.dataFile)) {
      return JSON.parse(fs.readFileSync(CONFIG.dataFile, 'utf8'));
    }
  } catch (error) {
    console.warn('Failed to load DB file, starting fresh:', error.message);
  }

  return {
    version: 1,
    counters: { position: 1, trade: 1 },
    settings: {},
    paper: { cash: CONFIG.paperStartBalance },
    marketPrices: [],
    sentimentItems: [],
    positions: [],
    trades: [],
    alerts: [],
    latestSentiment: null,
    topVolatile: []
  };
}

function initializeDb() {
  db.counters ||= { position: 1, trade: 1 };
  db.settings ||= {};
  db.paper ||= { cash: CONFIG.paperStartBalance };
  if (typeof db.paper.cash !== 'number') db.paper.cash = CONFIG.paperStartBalance;
  db.marketPrices ||= [];
  db.sentimentItems ||= [];
  db.positions ||= [];
  db.trades ||= [];
  db.alerts ||= [];
  db.topVolatile ||= [];
  saveDb();
}

function saveDb() {
  try {
    fs.writeFileSync(CONFIG.dataFile, JSON.stringify(db, null, 2));
  } catch (error) {
    console.error('Failed to save DB:', error.message);
  }
}

function trimDb() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  db.marketPrices = db.marketPrices.filter(p => p.timestamp >= cutoff).slice(-8000);
  db.sentimentItems = db.sentimentItems.filter(p => p.timestamp >= cutoff).slice(-500);
  db.alerts = db.alerts.filter(p => p.timestamp >= cutoff).slice(-500);
  db.trades = db.trades.slice(-1000);
}

function nextId(type) {
  db.counters[type] ||= 1;
  const id = db.counters[type];
  db.counters[type] += 1;
  return id;
}

function insertMarketPrice(row) {
  db.marketPrices.push(row);
}

function insertTrade(symbol, side, price, quantity, amount, pnl, reason) {
  db.trades.push({ id: nextId('trade'), symbol, side, price, quantity, amount, pnl, reason, timestamp: Date.now() });
}

function getPortfolioValue() {
  const cash = db.paper.cash;
  const openValue = db.positions.filter(p => p.status === 'open').reduce((sum, p) => {
    const last = getLastPrice(p.symbol) || p.entryPrice;
    return sum + p.quantity * last;
  }, 0);

  return { cash, openValue, total: cash + openValue };
}

function getLastPrice(symbol) {
  const rows = db.marketPrices.filter(p => p.symbol === symbol);
  const last = rows[rows.length - 1];
  return last ? Number(last.price) : null;
}

function getLastPriceTimestamp() {
  const last = db.marketPrices[db.marketPrices.length - 1];
  return last ? last.timestamp : null;
}

function getBestWorstMovers() {
  const rows = [];

  for (const symbol of watchlist) {
    const history = db.marketPrices.filter(p => p.symbol === symbol).slice(-2);
    if (history.length < 2) continue;
    const older = history[0];
    const recent = history[1];
    if (!older.price) continue;
    rows.push({ symbol, change: (recent.price - older.price) / older.price });
  }

  rows.sort((a, b) => b.change - a.change);
  return { best: rows[0], worst: rows[rows.length - 1] };
}

function getStrongestRecentSignal() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  return db.alerts.filter(a => a.timestamp >= cutoff).sort((a, b) => b.strength - a.strength)[0];
}

function getClosedTradesSince(timestamp) {
  return db.trades.filter(t => t.side === 'SELL' && t.timestamp >= timestamp);
}

function hasOpenPosition(symbol) {
  return db.positions.some(p => p.symbol === symbol && p.status === 'open');
}

function isBullishForSymbol(symbol) {
  const recent = getRecentSentimentForSymbol(symbol);
  return latestSentiment.label === 'bullish' || recent.some(item => item.label === 'bullish' || item.sentiment === 'bullish');
}

function isBearishForSymbol(symbol) {
  const recent = getRecentSentimentForSymbol(symbol);
  return latestSentiment.label === 'bearish' || recent.some(item => item.label === 'bearish' || item.sentiment === 'bearish');
}

function getRecentSentimentForSymbol(symbol) {
  const base = symbol.split('/')[0].toUpperCase();
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  return db.sentimentItems.filter(item => {
    const symbols = Array.isArray(item.symbols) ? item.symbols : String(item.symbols || '').split(',');
    return item.timestamp >= cutoff && (symbols.includes(base) || symbols.includes('ALL'));
  }).slice(-20);
}

function lostVolatilityRank(symbol) {
  if (!topVolatile.length) return false;
  const rank = topVolatile.findIndex(item => item.symbol === symbol);
  return rank === -1 || rank >= CONFIG.maxWatchlistSize + 5;
}

function buildSentimentSummary() {
  if (!latestSentiment || !latestSentiment.updatedAt) return 'neutral, waiting for headlines';
  const top = (latestSentiment.items || []).slice(0, 2).map(item => item.label).join(', ');
  return `${latestSentiment.label} (${round2(latestSentiment.score)} score${top ? `; recent ${top}` : ''})`;
}

function parseRss(xml, source) {
  const itemMatches = String(xml).match(/<item[\s\S]*?<\/item>/gi) || [];
  return itemMatches.map(item => ({
    title: decodeXml(extractTag(item, 'title')),
    url: decodeXml(extractTag(item, 'link')),
    source
  })).filter(item => item.title);
}

function dedupeArticles(articles) {
  const seen = new Set();
  return articles.filter(article => {
    const key = article.title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function matchSymbolsForHeadline(title) {
  const upper = String(title || '').toUpperCase();
  const matches = watchlist.filter(symbol => {
    const base = symbol.split('/')[0].toUpperCase();
    return upper.includes(base) || upper.includes(symbol.toUpperCase());
  }).map(symbol => symbol.split('/')[0].toUpperCase());
  return matches.length ? matches : ['ALL'];
}

function normalizeSentiment(label, score) {
  const value = String(label || '').toLowerCase();
  if (value.includes('bull')) return { label: 'bullish', score: clamp(score || 1, -2, 2) };
  if (value.includes('bear')) return { label: 'bearish', score: clamp(score || -1, -2, 2) };
  return { label: 'neutral', score: 0 };
}

function parseJsonLoose(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (_) { return null; }
}

function extractTag(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!match) return '';
  return match[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function safeSendMessage(message) {
  if (!bot || !CONFIG.telegramChatId) {
    console.log('Telegram disabled or TELEGRAM_CHAT_ID missing:', stripHtml(message));
    return;
  }

  try {
    await bot.sendMessage(CONFIG.telegramChatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  } catch (error) {
    console.error('Telegram send failed:', error.message);
  }
}

function isAllowedChat(msg) {
  if (!CONFIG.telegramChatId) return true;
  return String(msg.chat.id) === String(CONFIG.telegramChatId);
}

async function withRetry(fn, attempts, delayMs) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch (error) {
      lastError = error;
      if (i < attempts) await sleep(delayMs * i);
    }
  }
  throw lastError;
}

function parseWatchlist(raw) {
  return String(raw || '')
    .split(/[,\s]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .map(s => s.includes('/') ? s : `${s}/${CONFIG.baseSymbol}`)
    .filter((s, i, arr) => arr.indexOf(s) === i);
}

function cleanUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function average(values) { return values.reduce((a, b) => a + b, 0) / values.length; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value || 0))); }
function round2(value) { return Math.round(Number(value || 0) * 100) / 100; }
function round6(value) { return Math.round(Number(value || 0) * 1000000) / 1000000; }
function formatMoney(value) { return round2(value).toLocaleString('en-US'); }
function formatSignedMoney(value) { const n = round2(value); return `${n >= 0 ? '+' : ''}${n}`; }
function formatPercent(value) { const n = Number(value || 0) * 100; return `${n >= 0 ? '+' : ''}${round2(n)}%`; }
function formatTime(timestamp) { return new Date(timestamp).toISOString().slice(11, 16); }
function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}
function formatCompact(value) {
  const n = Number(value || 0);
  if (n >= 1e9) return `${round2(n / 1e9)}B`;
  if (n >= 1e6) return `${round2(n / 1e6)}M`;
  if (n >= 1e3) return `${round2(n / 1e3)}K`;
  return String(round2(n));
}
function stripHtml(text) { return String(text || '').replace(/<[^>]+>/g, ''); }
function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
