'use strict';

const { duration, money, percent, round, toMillis } = require('../utils/format');

function timestamp(value) {
  const ms = toMillis(value);
  return ms ? new Date(ms).toISOString() : 'n/a';
}

function formatTopVolatile(items) {
  if (!items || items.length === 0) return 'No volatility rankings yet.';
  return items.map((item, index) => {
    return `${index + 1}. ${item.symbol} | score ${round(item.rankScore, 3)} | vol ${round(item.volatilityScore, 3)} | momentum ${percent(item.priceChange)} | volume ${round(item.volumeRatio, 2)}x`;
  }).join('\n');
}

function formatTrades(trades, baseSymbol) {
  if (!trades || trades.length === 0) return 'No paper trades yet.';
  return trades.map((trade) => {
    const pnl = trade.pnl !== undefined ? ` | PnL ${money(trade.pnl, baseSymbol)} (${percent(trade.pnlPct || 0)})` : '';
    return `${trade.side} ${trade.symbol} @ ${round(trade.price, 8)} | ${money(trade.notional, baseSymbol)}${pnl} | ${timestamp(trade.executedAt)}`;
  }).join('\n');
}

function registerCommands({ bot, telegram, services, config, logger }) {
  const {
    portfolio,
    scanner,
    health,
    storage,
    strategy
  } = services;

  bot.on('message', async (msg) => {
    const text = String(msg.text || '').trim();
    if (!text.startsWith('/')) return;

    const chatId = msg.chat && msg.chat.id;
    if (config.telegram.chatId && String(chatId) !== String(config.telegram.chatId)) {
      logger.warn('Ignoring command from unauthorized chat', { chatId });
      return;
    }

    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand.split('@')[0].toLowerCase();

    try {
      switch (command) {
        case '/start':
          await telegram.sendMessage([
            'NyroTrade is online.',
            'Paper trading only. It monitors volatile spot markets, scores momentum and sentiment, and tracks a virtual portfolio.',
            '',
            'Commands: /status /portfolio /positions /watchlist /scanvolatile /topvolatile /trades /report /pause /resume /health'
          ].join('\n'), { chatId });
          break;

        case '/status': {
          const [settings, snapshot, watchlist] = await Promise.all([
            storage.getSettings(),
            portfolio.getSnapshot(),
            scanner.getWatchlist()
          ]);
          await telegram.sendMessage([
            'NyroTrade status',
            `Mode: ${settings.paused ? 'paused' : 'active'}`,
            `Uptime: ${duration(process.uptime())}`,
            `Equity: ${money(snapshot.equity, config.exchange.baseSymbol)}`,
            `Open positions: ${snapshot.positions.length}/${config.risk.maxOpenPositions}`,
            `Watchlist: ${watchlist.join(', ')}`
          ].join('\n'), { chatId });
          break;
        }

        case '/report': {
          const [snapshot, top, trades] = await Promise.all([
            portfolio.getSnapshot(),
            scanner.getTopVolatile(5),
            portfolio.getRecentTrades(5)
          ]);
          await telegram.sendMessage([
            portfolio.formatSnapshot(snapshot),
            '',
            'Top volatile',
            formatTopVolatile(top),
            '',
            'Recent trades',
            formatTrades(trades, config.exchange.baseSymbol)
          ].join('\n'), { chatId });
          break;
        }

        case '/watchlist': {
          const watchlist = await scanner.getWatchlist();
          await telegram.sendMessage(`Active watchlist\n${watchlist.join('\n')}`, { chatId });
          break;
        }

        case '/scanvolatile': {
          await telegram.sendMessage('Running a volatility scan now...', { chatId });
          const ranked = await scanner.scanVolatile({ force: true, limit: 50 });
          await telegram.sendMessage(`Volatility scan complete\n${formatTopVolatile(ranked.slice(0, 10))}`, { chatId });
          break;
        }

        case '/topvolatile': {
          const top = await scanner.getTopVolatile(10);
          await telegram.sendMessage(`Top volatile markets\n${formatTopVolatile(top)}`, { chatId });
          break;
        }

        case '/trades': {
          const trades = await portfolio.getRecentTrades(10);
          await telegram.sendMessage(`Recent paper trades\n${formatTrades(trades, config.exchange.baseSymbol)}`, { chatId });
          break;
        }

        case '/portfolio': {
          const snapshot = await portfolio.getSnapshot();
          await telegram.sendMessage(portfolio.formatSnapshot(snapshot), { chatId });
          break;
        }

        case '/positions': {
          const snapshot = await portfolio.getSnapshot();
          if (snapshot.positions.length === 0) {
            await telegram.sendMessage('No open paper positions.', { chatId });
          } else {
            await telegram.sendMessage(portfolio.formatSnapshot(snapshot), { chatId });
          }
          break;
        }

        case '/resetpaper': {
          if (String(args[0] || '').toLowerCase() !== 'confirm') {
            await telegram.sendMessage('To reset the virtual portfolio and paper trade history, send: /resetpaper confirm', { chatId });
            break;
          }
          const snapshot = await portfolio.reset();
          await telegram.sendMessage(`Paper portfolio reset.\n${portfolio.formatSnapshot(snapshot)}`, { chatId });
          break;
        }

        case '/pause':
          await storage.setPaused(true);
          await telegram.sendMessage('NyroTrade paused. Monitoring continues, but new paper entries are disabled.', { chatId });
          break;

        case '/resume':
          await storage.setPaused(false);
          await telegram.sendMessage('NyroTrade resumed. Strategy entries are enabled.', { chatId });
          await strategy.runOnce({ source: 'telegram-resume' });
          break;

        case '/health': {
          const status = await health.getStatus();
          await telegram.sendMessage([
            'NyroTrade health',
            `Status: ${status.status}`,
            `Firestore: ${status.firestore}`,
            `Webhook: ${status.webhook.configured ? 'configured' : 'not configured'}`,
            `Market update: ${status.latestMarketUpdate || 'n/a'}`,
            `Sentiment update: ${status.latestSentimentUpdate || 'n/a'}`,
            `Open positions: ${status.openPositionsCount}`,
            `Cache: ${JSON.stringify(status.cacheSize)}`
          ].join('\n'), { chatId });
          break;
        }

        default:
          await telegram.sendMessage('Unknown command. Try /status, /portfolio, /watchlist, /scanvolatile, /topvolatile, /trades, /pause, /resume, or /health.', { chatId });
      }
    } catch (error) {
      logger.error('Telegram command failed', { command, error });
      await telegram.sendMessage(`Command failed: ${error.message}`, { chatId });
    }
  });
}

module.exports = {
  registerCommands
};
