require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');
const ccxt = require('ccxt');
const Database = require('better-sqlite3');

const CONFIG = {
  botToken: process.env.BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  webhookUrl: process.env.WEBHOOK_URL,
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  port: Number(process.env.PORT || 3000),
  baseSymbol: process.env.BASE_SYMBOL || 'USDT',
  paperStartBalance: Number(process.env.PAPER_START_BALANCE || 100),
  ollamaUrl: process.env.OLLAMA_URL,
  watchlist: parseWatchlist(process.env.WATCHLIST || 'BTC/USDT,ETH/USDT,SOL/USDT,WIF/USDT')
};

const STARTED_AT = Date.now();
const DB_PATH = process.env.SQLITE_PATH || 'paper_trading.sqlite';
const MAX_TRADE_FRACTION = 0.2;
const MAX_OPEN_POSITIONS = 3;
const STOP_LOSS = -0.03;
const TAKE_PROFIT = 0.05;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const NEWS_SOURCES = [
  'https://cointelegraph.com/rss',
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://cryptopotato.com/feed/'
];

let bot = null;
let marketExchange = null;
let monitoringPaused = false;
let cronStarted = false;
let marketJobRunning = false;
let newsJobRunning = false;
let reportJobRunning = false;
let watchlist = CONFIG.watchlist;
let latestSentiment = { label: 'neutral', score: 0, items: [], updatedAt: null };
const lastAlertAt = new Map();

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
initializeDatabase();
initializeSettings();

if (!CONFIG.botToken) {
  console.warn('BOT_TOKEN is missing. Telegram webhook is disabled until it is configured.');
} else {
  bot = new TelegramBot(CONFIG.botToken, { polling: false });
  registerTelegramCommands();
}

marketExchange = new ccxt.binance({
  apiKey: process.env.BINANCE_API_KEY || undefined,
  secret: process.env.BINANCE_API_SECRET || undefined,
  enableRateLimit: true,
  timeout: 15000
});

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('Bot is running'));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: formatDuration(Date.now() - STARTED_AT),
    watchlist,
    paperBalance: round2(getPaperBalance()),
    paused: monitoringPaused,
    webhookMode: true,
    webhookUrlConfigured: Boolean(process.env.WEBHOOK_URL)
  });
});

app.post('/telegram-webhook', (req, res) => {
  if (!bot) {
    res.sendStatus(503);
    return;
  }

  if (CONFIG.webhookSecret) {
    const incomingSecret = req.header('x-telegram-bot-api-secret-token');
    if (incomingSecret !== CONFIG.webhookSecret) {
      res.sendStatus(403);
      return;
    }
  }

  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error('Telegram webhook update failed:', error.message);
    res.sendStatus(500);
  }
});

app.listen(CONFIG.port, async () => {
  console.log(`Express server listening on port ${CONFIG.port}`);
  await setupTelegramWebhook();
});

startCronJobs();
runStartupWarmup();

process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  safeSendMessage(`Bot recovered from an unexpected error: ${escapeHtml(error.message || 'unknown error')}`);
});

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      price REAL NOT NULL,
      volume REAL NOT NULL,
      percentage REAL NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_market_symbol_time ON market_prices(symbol, timestamp);
    CREATE TABLE IF NOT EXISTS sentiment_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      url TEXT,
      source TEXT,
      sentiment TEXT NOT NULL,
      score REAL NOT NULL,
      symbols TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      entry_price REAL NOT NULL,
      quantity REAL NOT NULL,
      invested REAL NOT NULL,
      opened_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
    );
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      quantity REAL NOT NULL,
      amount REAL NOT NULL,
      pnl REAL NOT NULL DEFAULT 0,
      reason TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      message TEXT NOT NULL,
      strength REAL NOT NULL,
      timestamp INTEGER NOT NULL
    );
  `);
}

function initializeSettings() {
  setSettingIfMissing('paperBalance', String(CONFIG.paperStartBalance));
  setSettingIfMissing('watchlist', watchlist.join(','));
  setSettingIfMissing('paused', 'false');
  watchlist = parseWatchlist(getSetting('watchlist') || watchlist.join(','));
  monitoringPaused = getSetting('paused') === 'true';
}

function startCronJobs() {
  if (cronStarted) return;
  cronStarted = true;
  cron.schedule('*/5 * * * *', () => guardedMarketMonitor());
  cron.schedule('*/30 * * * *', () => guardedNewsSentiment());
  cron.schedule('0 * * * *', () => guardedHourlyReport());
  console.log('Cron jobs started: market 5m, sentiment 30m, report hourly.');
}

async function runStartupWarmup() {
  await sleep(1500);
  await guardedMarketMonitor();
  await guardedNewsSentiment();
}

function registerTelegramCommands() {
  bot.onText(/^\/start$/, (msg) => {
    if (!isAllowedChat(msg)) return;
    safeSendMessage([
      '<b>Crypto AI Paper Trading Assistant</b>',
      '',
      'I monitor crypto markets, analyze headlines, simulate paper trades, and send hourly progress reports.',
      '',
      '<b>Important:</b> educational paper trading only. I never place real trades, and I cannot promise profit.',
      '',
      'Commands:',
      '/status - portfolio and P/L',
      '/watchlist - tracked symbols',
      '/setwatchlist BTC/USDT ETH/USDT SOL/USDT - update symbols',
      '/report - send current report',
      '/trades - last simulated trades',
      '/resetpaper - reset fake balance to starting value',
      '/pause - pause monitoring',
      '/resume - resume monitoring'
    ].join('\n'));
  });

  bot.onText(/^\/status$/, async (msg) => {
    if (!isAllowedChat(msg)) return;
    safeSendMessage(await buildStatusMessage());
  });

  bot.onText(/^\/watchlist$/, (msg) => {
    if (!isAllowedChat(msg)) return;
    safeSendMessage(`<b>Watchlist</b>\n${watchlist.map((s) => `- ${s}`).join('\n')}`);
  });

  bot.onText(/^\/setwatchlist(?:\s+(.+))?$/, (msg, match) => {
    if (!isAllowedChat(msg)) return;
    const symbols = parseWatchlist(match[1] || '');
    if (!symbols.length) {
      safeSendMessage('Usage: /setwatchlist BTC/USDT ETH/USDT SOL/USDT');
      return;
    }
    watchlist = symbols;
    setSetting('watchlist', watchlist.join(','));
    safeSendMessage(`<b>Watchlist updated</b>\n${watchlist.map((s) => `- ${s}`).join('\n')}`);
  });

  bot.onText(/^\/report$/, async (msg) => {
    if (!isAllowedChat(msg)) return;
    safeSendMessage(await buildHourlyReport());
  });

  bot.onText(/^\/trades$/, (msg) => {
    if (!isAllowedChat(msg)) return;
    safeSendMessage(buildTradesMessage());
  });

  bot.onText(/^\/resetpaper$/, (msg) => {
    if (!isAllowedChat(msg)) return;
    resetPaperTrading();
    safeSendMessage(`Paper trading reset to ${round2(CONFIG.paperStartBalance)} ${CONFIG.baseSymbol}.`);
  });

  bot.onText(/^\/pause$/, (msg) => {
    if (!isAllowedChat(msg)) return;
    monitoringPaused = true;
    setSetting('paused', 'true');
    safeSendMessage('Monitoring paused. Use /resume to continue.');
  });

  bot.onText(/^\/resume$/, (msg) => {
    if (!isAllowedChat(msg)) return;
    monitoringPaused = false;
    setSetting('paused', 'false');
    safeSendMessage('Monitoring resumed.');
  });

  bot.on('error', (error) => console.error('Telegram bot error:', error.message));
}

async function setupTelegramWebhook() {
  if (!bot) return;

  if (!CONFIG.webhookUrl) {
    console.warn('WEBHOOK_URL missing, Telegram webhook will not be registered.');
    return;
  }

  const normalizedBaseUrl = CONFIG.webhookUrl.replace(/\/$/, '');
  const webhookEndpoint = `${normalizedBaseUrl}/telegram-webhook`;
  const webhookOptions = CONFIG.webhookSecret
    ? { secret_token: CONFIG.webhookSecret }
    : {};

  try {
    const currentWebhook = await bot.getWebHookInfo();
    if (currentWebhook && currentWebhook.url && currentWebhook.url !== webhookEndpoint) {
      await bot.deleteWebHook();
      console.log(`Deleted old Telegram webhook: ${currentWebhook.url}`);
    }

    await bot.setWebHook(webhookEndpoint, webhookOptions);
    console.log(`Telegram webhook registered: ${webhookEndpoint}`);
  } catch (error) {
    console.error('Telegram webhook setup failed:', error.message);
  }
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
    await safeSendMessage(await buildHourlyReport());
  } catch (error) {
    console.error('Hourly report failed:', error.message);
  } finally {
    reportJobRunning = false;
  }
}

async function monitorMarkets() {
  console.log(`Fetching market data for ${watchlist.join(', ')}`);
  const tickers = await fetchTickersWithRetry(watchlist);
  const now = Date.now();
  const signals = [];

  for (const symbol of watchlist) {
    const ticker = tickers[symbol];
    if (!ticker || !ticker.last) continue;

    const price = Number(ticker.last);
    const volume = Number(ticker.quoteVolume || ticker.baseVolume || 0);
    const percentage = Number(ticker.percentage || 0);
    insertMarketPrice(symbol, price, volume, percentage, now);

    const signal = detectSignal(symbol, price, volume, percentage, now);
    signals.push(signal);
    if (signal.strong) {
      await maybeSendSignalAlert(signal);
    }
  }

  await runPaperTrading(signals);
}

async function fetchTickersWithRetry(symbols) {
  return withRetry(async () => {
    const result = {};
    try {
      const tickers = await marketExchange.fetchTickers(symbols);
      for (const symbol of symbols) result[symbol] = tickers[symbol];
    } catch (error) {
      console.warn('Bulk ticker fetch failed, trying symbol-by-symbol:', error.message);
      for (const symbol of symbols) {
        try {
          result[symbol] = await marketExchange.fetchTicker(symbol);
        } catch (innerError) {
          console.error(`Ticker fetch failed for ${symbol}:`, innerError.message);
        }
      }
    }
    return result;
  }, 2, 1200);
}

function detectSignal(symbol, price, volume, percentage, now) {
  const previous = db.prepare(`
    SELECT price, volume FROM market_prices
    WHERE symbol = ? AND timestamp < ?
    ORDER BY timestamp DESC LIMIT 1
  `).get(symbol, now);

  const avg = db.prepare(`
    SELECT AVG(volume) AS avgVolume FROM (
      SELECT volume FROM market_prices
      WHERE symbol = ? AND timestamp < ?
      ORDER BY timestamp DESC LIMIT 12
    )
  `).get(symbol, now);

  const priceChange = previous && previous.price ? (price - previous.price) / previous.price : percentage / 100;
  const avgVolume = Number(avg && avg.avgVolume ? avg.avgVolume : volume);
  const volumeRatio = avgVolume > 0 ? volume / avgVolume : 1;
  const pump = priceChange >= 0.03;
  const dump = priceChange <= -0.03;
  const volumeSpike = volumeRatio >= 1.8;
  const strong = (pump || dump) && volumeSpike;
  const direction = pump ? 'pump' : dump ? 'dump' : priceChange > 0 ? 'up' : priceChange < 0 ? 'down' : 'flat';
  const strength = Math.abs(priceChange) * 100 + Math.max(0, volumeRatio - 1);

  return {
    symbol,
    price,
    volume,
    percentage,
    priceChange,
    volumeRatio,
    volumeSpike,
    strong,
    direction,
    strength,
    timestamp: now
  };
}

async function maybeSendSignalAlert(signal) {
  const key = `${signal.symbol}:${signal.direction}`;
  const last = lastAlertAt.get(key) || 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) return;

  const message = [
    '<b>Strong Market Signal</b>',
    `${signal.symbol}: ${signal.direction.toUpperCase()}`,
    `Price: ${formatMoney(signal.price)}`,
    `Short move: ${formatPercent(signal.priceChange)}`,
    `Volume: ${round2(signal.volumeRatio)}x recent average`
  ].join('\n');

  insertAlert(signal.symbol, message, signal.strength, signal.timestamp);
  lastAlertAt.set(key, Date.now());
  await safeSendMessage(message);
}

async function fetchAndAnalyzeNews() {
  console.log('Fetching crypto news sentiment');
  const articles = [];
  for (const sourceUrl of NEWS_SOURCES) {
    try {
      const response = await axios.get(sourceUrl, { timeout: 12000, headers: { 'User-Agent': 'crypto-paper-bot/1.0' } });
      articles.push(...parseRss(response.data, sourceUrl));
    } catch (error) {
      console.warn(`News source failed ${sourceUrl}:`, error.message);
    }
  }

  const unique = dedupeArticles(articles).slice(0, 18);
  const analyzed = [];
  for (const item of unique) {
    const analysis = await analyzeHeadline(item.title);
    const symbols = matchSymbolsForHeadline(item.title);
    insertSentimentItem(item, analysis, symbols);
    analyzed.push({ ...item, ...analysis, symbols });
  }

  const score = analyzed.reduce((sum, item) => sum + item.score, 0);
  const label = score > 1.5 ? 'bullish' : score < -1.5 ? 'bearish' : 'neutral';
  return { label, score, items: analyzed, updatedAt: Date.now() };
}

async function analyzeHeadline(title) {
  if (CONFIG.ollamaUrl) {
    try {
      const response = await axios.post(`${CONFIG.ollamaUrl.replace(/\/$/, '')}/api/generate`, {
        model: process.env.OLLAMA_MODEL || 'llama3.1',
        prompt: `Classify this crypto news headline as bullish, bearish, or neutral. Return only JSON with label and score from -2 to 2.\nHeadline: ${title}`,
        stream: false
      }, { timeout: 20000 });
      const parsed = parseJsonLoose(response.data && response.data.response);
      if (parsed && parsed.label) {
        return normalizeSentiment(parsed.label, Number(parsed.score || 0));
      }
    } catch (error) {
      console.warn('Ollama sentiment failed, using rule-based fallback:', error.message);
    }
  }
  return ruleBasedSentiment(title);
}

function ruleBasedSentiment(text) {
  const lower = text.toLowerCase();
  const bullishWords = ['surge', 'rally', 'gain', 'breakout', 'bull', 'approve', 'inflow', 'record', 'partnership', 'adoption', 'upgrade', 'recover'];
  const bearishWords = ['drop', 'dump', 'fall', 'crash', 'bear', 'hack', 'lawsuit', 'outflow', 'ban', 'exploit', 'liquidation', 'plunge', 'selloff'];
  let score = 0;
  for (const word of bullishWords) if (lower.includes(word)) score += 1;
  for (const word of bearishWords) if (lower.includes(word)) score -= 1;
  return normalizeSentiment(score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral', Math.max(-2, Math.min(2, score)));
}

async function runPaperTrading(signals) {
  const openPositions = getOpenPositions();

  for (const position of openPositions) {
    const signal = signals.find((s) => s.symbol === position.symbol);
    if (!signal) continue;
    const pnlPct = (signal.price - position.entry_price) / position.entry_price;
    const bearishForSymbol = isBearishForSymbol(position.symbol);
    const reversal = signal.priceChange < -0.015 && signal.volumeSpike;
    if (pnlPct <= STOP_LOSS) {
      closePosition(position, signal.price, 'stop loss');
    } else if (pnlPct >= TAKE_PROFIT) {
      closePosition(position, signal.price, 'take profit');
    } else if (bearishForSymbol) {
      closePosition(position, signal.price, 'bearish sentiment');
    } else if (reversal) {
      closePosition(position, signal.price, 'momentum reversal');
    }
  }

  const refreshedOpenCount = getOpenPositions().length;
  if (refreshedOpenCount >= MAX_OPEN_POSITIONS) return;

  for (const signal of signals.sort((a, b) => b.strength - a.strength)) {
    if (getOpenPositions().length >= MAX_OPEN_POSITIONS) break;
    if (hasOpenPosition(signal.symbol)) continue;

    const bullish = isBullishForSymbol(signal.symbol);
    const positiveMomentum = signal.priceChange > 0.01 || signal.percentage > 1;
    if (bullish && positiveMomentum && signal.volumeSpike) {
      openPosition(signal.symbol, signal.price, 'bullish sentiment + momentum + volume');
    }
  }
}

function openPosition(symbol, price, reason) {
  const balance = getPaperBalance();
  const amount = Math.min(balance * MAX_TRADE_FRACTION, balance);
  if (amount < 1) return;
  const quantity = amount / price;
  setPaperBalance(balance - amount);
  db.prepare(`
    INSERT INTO positions (symbol, entry_price, quantity, invested, opened_at, status)
    VALUES (?, ?, ?, ?, ?, 'open')
  `).run(symbol, price, quantity, amount, Date.now());
  insertTrade(symbol, 'BUY', price, quantity, amount, 0, reason);
  console.log(`Paper BUY ${symbol} amount=${amount} price=${price}`);
}

function closePosition(position, price, reason) {
  const amount = position.quantity * price;
  const pnl = amount - position.invested;
  setPaperBalance(getPaperBalance() + amount);
  db.prepare('UPDATE positions SET status = ? WHERE id = ?').run('closed', position.id);
  insertTrade(position.symbol, 'SELL', price, position.quantity, amount, pnl, reason);
  console.log(`Paper SELL ${position.symbol} pnl=${pnl} reason=${reason}`);
}

async function buildStatusMessage() {
  const value = getPortfolioValue();
  const openPositions = getOpenPositions();
  const lines = [
    '<b>Paper Portfolio Status</b>',
    `Cash: ${round2(value.cash)} ${CONFIG.baseSymbol}`,
    `Open value: ${round2(value.openValue)} ${CONFIG.baseSymbol}`,
    `Portfolio value: ${round2(value.total)} ${CONFIG.baseSymbol}`,
    `Total P/L: ${formatSignedMoney(value.total - CONFIG.paperStartBalance)} ${CONFIG.baseSymbol}`,
    ''
  ];

  if (!openPositions.length) {
    lines.push('Open positions: none');
  } else {
    lines.push('<b>Open Positions</b>');
    for (const position of openPositions) {
      const last = getLastPrice(position.symbol) || position.entry_price;
      const pnlPct = (last - position.entry_price) / position.entry_price;
      lines.push(`${position.symbol}: ${round6(position.quantity)} @ ${formatMoney(position.entry_price)} (${formatPercent(pnlPct)})`);
    }
  }

  return lines.join('\n');
}

async function buildHourlyReport() {
  const value = getPortfolioValue();
  const movers = getBestWorstMovers();
  const strongest = getStrongestRecentSignal();
  const closedTrades = getClosedTradesSince(Date.now() - 60 * 60 * 1000);
  const openPositions = getOpenPositions();
  const sentimentSummary = buildSentimentSummary();

  return [
    '<b>Hourly Paper Trading Report</b>',
    `Cash: ${round2(value.cash)} ${CONFIG.baseSymbol}`,
    `Portfolio: ${round2(value.total)} ${CONFIG.baseSymbol} (${formatSignedMoney(value.total - CONFIG.paperStartBalance)} P/L)`,
    `Open positions: ${openPositions.length ? openPositions.map((p) => p.symbol).join(', ') : 'none'}`,
    `Closed last hour: ${closedTrades.length || 0}`,
    `Best watched: ${movers.best ? `${movers.best.symbol} ${formatPercent(movers.best.change)}` : 'n/a'}`,
    `Worst watched: ${movers.worst ? `${movers.worst.symbol} ${formatPercent(movers.worst.change)}` : 'n/a'}`,
    `Strongest signal: ${strongest ? `${strongest.symbol} strength ${round2(strongest.strength)}` : 'none'}`,
    `Sentiment: ${sentimentSummary}`,
    `Uptime: ${formatDuration(Date.now() - STARTED_AT)}`,
    `Next action: ${monitoringPaused ? 'paused' : 'continue monitoring, only alert on strong signals'}`
  ].join('\n');
}

function buildTradesMessage() {
  const trades = db.prepare('SELECT * FROM trades ORDER BY timestamp DESC LIMIT 10').all();
  if (!trades.length) return 'No simulated trades yet.';
  return [
    '<b>Last Simulated Trades</b>',
    ...trades.map((trade) => `${formatTime(trade.timestamp)} ${trade.side} ${trade.symbol} ${round2(trade.amount)} ${CONFIG.baseSymbol} P/L ${formatSignedMoney(trade.pnl)} (${trade.reason})`)
  ].join('\n');
}

function resetPaperTrading() {
  db.prepare('DELETE FROM positions').run();
  db.prepare('DELETE FROM trades').run();
  setPaperBalance(CONFIG.paperStartBalance);
}

function getPortfolioValue() {
  const cash = getPaperBalance();
  const openPositions = getOpenPositions();
  const openValue = openPositions.reduce((sum, position) => {
    const price = getLastPrice(position.symbol) || position.entry_price;
    return sum + position.quantity * price;
  }, 0);
  return { cash, openValue, total: cash + openValue };
}

function getBestWorstMovers() {
  const rows = watchlist.map((symbol) => {
    const recent = db.prepare('SELECT price FROM market_prices WHERE symbol = ? ORDER BY timestamp DESC LIMIT 1').get(symbol);
    const older = db.prepare('SELECT price FROM market_prices WHERE symbol = ? ORDER BY timestamp DESC LIMIT 1 OFFSET 1').get(symbol);
    if (!recent || !older || !older.price) return null;
    return { symbol, change: (recent.price - older.price) / older.price };
  }).filter(Boolean);
  rows.sort((a, b) => b.change - a.change);
  return { best: rows[0], worst: rows[rows.length - 1] };
}

function getStrongestRecentSignal() {
  return db.prepare('SELECT symbol, strength FROM alerts WHERE timestamp > ? ORDER BY strength DESC LIMIT 1').get(Date.now() - 60 * 60 * 1000);
}

function buildSentimentSummary() {
  if (!latestSentiment.updatedAt) return 'neutral, waiting for fresh headlines';
  const top = latestSentiment.items.slice(0, 2).map((item) => item.label).join(', ');
  return `${latestSentiment.label} (${round2(latestSentiment.score)} score${top ? `; recent ${top}` : ''})`;
}

function isBullishForSymbol(symbol) {
  const recent = getRecentSentimentForSymbol(symbol);
  return latestSentiment.label === 'bullish' || recent.some((item) => item.sentiment === 'bullish');
}

function isBearishForSymbol(symbol) {
  const recent = getRecentSentimentForSymbol(symbol);
  return latestSentiment.label === 'bearish' || recent.some((item) => item.sentiment === 'bearish');
}

function getRecentSentimentForSymbol(symbol) {
  const base = symbol.split('/')[0].toUpperCase();
  return db.prepare(`
    SELECT * FROM sentiment_items
    WHERE timestamp > ? AND (symbols LIKE ? OR symbols = 'ALL')
    ORDER BY timestamp DESC LIMIT 20
  `).all(Date.now() - 2 * 60 * 60 * 1000, `%${base}%`);
}

function parseRss(xml, source) {
  const itemMatches = String(xml).match(/<item[\s\S]*?<\/item>/gi) || [];
  return itemMatches.map((item) => ({
    title: decodeXml(extractTag(item, 'title')),
    url: decodeXml(extractTag(item, 'link')),
    source
  })).filter((item) => item.title);
}

function dedupeArticles(articles) {
  const seen = new Set();
  return articles.filter((article) => {
    const key = article.title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function matchSymbolsForHeadline(title) {
  const upper = title.toUpperCase();
  const matches = watchlist.filter((symbol) => {
    const base = symbol.split('/')[0].toUpperCase();
    return upper.includes(base) || upper.includes(symbol.toUpperCase());
  }).map((symbol) => symbol.split('/')[0].toUpperCase());
  return matches.length ? matches : ['ALL'];
}

function normalizeSentiment(label, score) {
  const normalized = String(label).toLowerCase();
  if (normalized.includes('bull')) return { label: 'bullish', score: clamp(score || 1, -2, 2) };
  if (normalized.includes('bear')) return { label: 'bearish', score: clamp(score || -1, -2, 2) };
  return { label: 'neutral', score: 0 };
}

function parseJsonLoose(text) {
  if (!text) return null;
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
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

function parseWatchlist(raw) {
  const baseSymbol = process.env.BASE_SYMBOL || 'USDT';
  return String(raw || '')
    .split(/[,\s]+/)
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean)
    .map((symbol) => symbol.includes('/') ? symbol : `${symbol}/${baseSymbol}`)
    .filter((symbol, index, list) => list.indexOf(symbol) === index);
}

function insertMarketPrice(symbol, price, volume, percentage, timestamp) {
  db.prepare('INSERT INTO market_prices (symbol, price, volume, percentage, timestamp) VALUES (?, ?, ?, ?, ?)')
    .run(symbol, price, volume, percentage, timestamp);
}

function insertSentimentItem(item, analysis, symbols) {
  db.prepare('INSERT INTO sentiment_items (title, url, source, sentiment, score, symbols, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(item.title, item.url || '', item.source || '', analysis.label, analysis.score, symbols.join(','), Date.now());
}

function insertTrade(symbol, side, price, quantity, amount, pnl, reason) {
  db.prepare('INSERT INTO trades (symbol, side, price, quantity, amount, pnl, reason, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(symbol, side, price, quantity, amount, pnl, reason, Date.now());
}

function insertAlert(symbol, message, strength, timestamp) {
  db.prepare('INSERT INTO alerts (symbol, message, strength, timestamp) VALUES (?, ?, ?, ?)')
    .run(symbol, message, strength, timestamp);
}

function getOpenPositions() {
  return db.prepare("SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at ASC").all();
}

function hasOpenPosition(symbol) {
  return Boolean(db.prepare("SELECT id FROM positions WHERE symbol = ? AND status = 'open' LIMIT 1").get(symbol));
}

function getClosedTradesSince(timestamp) {
  return db.prepare("SELECT * FROM trades WHERE side = 'SELL' AND timestamp >= ? ORDER BY timestamp DESC").all(timestamp);
}

function getLastPrice(symbol) {
  const row = db.prepare('SELECT price FROM market_prices WHERE symbol = ? ORDER BY timestamp DESC LIMIT 1').get(symbol);
  return row ? Number(row.price) : null;
}

function getPaperBalance() {
  return Number(getSetting('paperBalance') || CONFIG.paperStartBalance);
}

function setPaperBalance(value) {
  setSetting('paperBalance', String(Math.max(0, value)));
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row && row.value;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function setSettingIfMissing(key, value) {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

function isAllowedChat(msg) {
  if (!CONFIG.telegramChatId) return true;
  return String(msg.chat.id) === String(CONFIG.telegramChatId);
}

async function safeSendMessage(message) {
  if (!bot || !CONFIG.telegramChatId) {
    console.log('Telegram disabled or TELEGRAM_CHAT_ID missing. Message:', stripHtml(message));
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

async function withRetry(fn, attempts, delayMs) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function round6(value) {
  return Math.round(Number(value || 0) * 1000000) / 1000000;
}

function formatMoney(value) {
  return round2(value).toLocaleString('en-US');
}

function formatSignedMoney(value) {
  const rounded = round2(value);
  return `${rounded >= 0 ? '+' : ''}${rounded}`;
}

function formatPercent(value) {
  const percent = Number(value || 0) * 100;
  return `${percent >= 0 ? '+' : ''}${round2(percent)}%`;
}

function formatTime(timestamp) {
  return new Date(timestamp).toISOString().slice(11, 16);
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function stripHtml(text) {
  return String(text).replace(/<[^>]+>/g, '');
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}