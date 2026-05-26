'use strict';

const { duration, money, percent, round, toMillis } = require('../utils/format');
const { STRATEGIES } = require('../strategies/registry');

function timestamp(value) {
  const ms = toMillis(value);
  return ms ? new Date(ms).toISOString() : 'n/a';
}

function formatTopVolatile(items) {
  if (!items || items.length === 0) return 'No volatility rankings yet.';
  return items.map((item, index) => {
    return `${index + 1}. ${item.symbol} | score ${round(item.rankScore, 3)} | ATR ${percent(item.atrPercent || 0)} | momentum ${percent(item.priceChange)} | volume ${round(item.volumeRatio, 2)}x`;
  }).join('\n');
}

function formatTrades(trades, baseSymbol) {
  if (!trades || trades.length === 0) return 'No paper trades yet.';
  return trades.map((trade) => {
    const pnl = trade.pnl !== undefined ? ` | PnL ${money(trade.pnl, baseSymbol)} (${percent(trade.pnlPct || 0)})` : '';
    const label = trade.strategyKey && trade.strategyKey !== 'legacy' ? ` [${trade.strategyKey}]` : '';
    return `${trade.side}${label} ${trade.symbol} @ ${round(trade.price, 8)} | ${money(trade.notional, baseSymbol)}${pnl} | ${timestamp(trade.executedAt)}`;
  }).join('\n');
}

function formatCooldowns(cooldowns) {
  if (!cooldowns || cooldowns.length === 0) return 'No active cooldowns.';
  return cooldowns.slice(0, 8).map((cooldown) => {
    const expiresAt = timestamp(cooldown.expiresAt);
    return `${cooldown.key || cooldown.id} until ${expiresAt}`;
  }).join('\n');
}

function formatStrategyComparison(analytics, baseSymbol) {
  const rows = (analytics && analytics.strategies) || [];
  if (!rows.length) return 'No strategy stats yet.';
  const nameByKey = STRATEGIES.reduce((acc, s) => {
    acc[s.key] = s.name;
    return acc;
  }, {});
  return rows.map((row) => {
    const name = nameByKey[row.strategyKey] || row.strategyKey;
    const pnl = money(row.totalRealizedPnl || 0, baseSymbol);
    return `${name}: ${pnl} | win ${percent(row.winRate || 0)} | PF ${round(row.profitFactor || 0, 2)} | DD ${percent(row.maxDrawdown || 0)}`;
  }).join('\n');
}

function registerCommands({ bot, telegram, services, config, logger }) {
  const {
    portfolio,
    scanner,
    health,
    storage,
    strategy,
    analytics,
    marketRegime
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
            'Paper trading only. Multi-strategy research platform: WaveHunter, MomentumPulse, WhaleShadow, SentinelMind.',
            '',
            'Commands: /status /report /stats /strategies /wave /whales /sentiment /positions /watchlist /topvolatile /trades /pause /resume /resetpaper /health'
          ].join('\n'), { chatId });
          break;

        case '/status': {
          const [settings, snapshot, watchlist] = await Promise.all([
            storage.getSettings(),
            portfolio.getSnapshot({ strategyKey: 'momentumpulse' }).catch(() => portfolio.getSnapshot()),
            scanner.getWatchlist()
          ]);
          await telegram.sendMessage([
            'NyroTrade status',
            `Mode: ${settings.paused ? 'paused' : 'active'}`,
            `Uptime: ${duration(process.uptime())}`,
            `MomentumPulse equity: ${money(snapshot.equity, config.exchange.baseSymbol)}`,
            `MomentumPulse open: ${snapshot.positions.length}/${config.risk.maxOpenPositions}`,
            `Watchlist: ${watchlist.join(', ')}`
          ].join('\n'), { chatId });
          break;
        }

        case '/report': {
          const [snapshot, top, trades, cooldowns, diagnostics, regime, stats] = await Promise.all([
            portfolio.getSnapshot({ strategyKey: 'momentumpulse' }).catch(() => portfolio.getSnapshot()),
            scanner.getTopVolatile(5),
            portfolio.getRecentTrades(5),
            storage.getActiveCooldowns(12),
            storage.getStrategyDiagnostics(),
            marketRegime.getCurrent(),
            analytics.getLatestOrCompute()
          ]);
          await telegram.sendMessage([
            'NyroTrade research report',
            `Market regime: ${regime.regime} | aggressiveness ${percent(regime.aggressiveness)}`,
            `Strategy health: ${percent((diagnostics && diagnostics.strategyHealthScore) || 0)}`,
            `Recent win rate: ${percent((stats && stats.recentWinRate) || 0)}`,
            '',
            'Strategy comparison',
            formatStrategyComparison(stats, config.exchange.baseSymbol),
            '',
            portfolio.formatSnapshot(snapshot),
            `Exposure: meme ${percent((snapshot.exposurePct && snapshot.exposurePct.meme) || 0)} | volatile ${percent((snapshot.exposurePct && snapshot.exposurePct.volatile) || 0)} | core ${percent((snapshot.exposurePct && snapshot.exposurePct.core) || 0)}`,
            '',
            'Top volatile',
            formatTopVolatile(top),
            '',
            'Active cooldowns',
            formatCooldowns(cooldowns),
            '',
            'Recent trades',
            formatTrades(trades, config.exchange.baseSymbol)
          ].join('\n'), { chatId });
          break;
        }

        case '/stats': {
          const stats = await analytics.refresh();
          await telegram.sendMessage(analytics.formatStats(stats), { chatId });
          break;
        }

        case '/strategies': {
          const stats = await analytics.getLatestOrCompute();
          await telegram.sendMessage([
            'NyroTrade strategies',
            formatStrategyComparison(stats, config.exchange.baseSymbol)
          ].join('\n'), { chatId });
          break;
        }

        case '/wave': {
          const stats = await storage.getLatestStrategyAnalytics('wavehunter').catch(() => null);
          await telegram.sendMessage(stats ? analytics.formatStats(stats) : 'WaveHunter stats not ready yet. Wait for /stats to run.', { chatId });
          break;
        }

        case '/whales': {
          const stats = await storage.getLatestStrategyAnalytics('whaleshadow').catch(() => null);
          await telegram.sendMessage(stats ? analytics.formatStats(stats) : 'WhaleShadow stats not ready yet. Wait for /stats to run.', { chatId });
          break;
        }

        case '/sentiment': {
          const stats = await storage.getLatestStrategyAnalytics('sentinelmind').catch(() => null);
          const market = await storage.getLatestSentiment('MARKET').catch(() => null);
          await telegram.sendMessage([
            stats ? analytics.formatStats(stats) : 'SentinelMind stats not ready yet. Wait for /stats to run.',
            '',
            market
              ? `Market sentiment: ${market.label} score ${round(market.score, 2)} conf ${percent(market.confidence || 0)}`
              : 'Market sentiment: n/a'
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
          const snapshot = await portfolio.getSnapshot({ strategyKey: 'momentumpulse' }).catch(() => portfolio.getSnapshot());
          await telegram.sendMessage(`MomentumPulse portfolio\n${portfolio.formatSnapshot(snapshot)}`, { chatId });
          break;
        }

        case '/positions': {
          const snapshots = await Promise.all([
            portfolio.getSnapshot({ strategyKey: 'wavehunter' }),
            portfolio.getSnapshot({ strategyKey: 'momentumpulse' }),
            portfolio.getSnapshot({ strategyKey: 'whaleshadow' }),
            portfolio.getSnapshot({ strategyKey: 'sentinelmind' })
          ]).catch(() => []);

          if (!snapshots.length) {
            const fallback = await portfolio.getSnapshot();
            await telegram.sendMessage(fallback.positions.length ? portfolio.formatSnapshot(fallback) : 'No open paper positions.', { chatId });
            break;
          }

          const texts = [];
          const keys = ['WaveHunter', 'MomentumPulse', 'WhaleShadow', 'SentinelMind'];
          snapshots.forEach((snap, idx) => {
            texts.push(`${keys[idx]} (${snap.positions.length} open)\n${portfolio.formatSnapshot(snap)}`);
          });
          await telegram.sendMessage(texts.join('\n\n'), { chatId });
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
            `Strategy health: ${status.strategyHealthScore === null ? 'n/a' : percent(status.strategyHealthScore)}`,
            `Market regime: ${status.marketRegime || 'n/a'}`,
            `Cache: ${JSON.stringify(status.cacheSize)}`
          ].join('\n'), { chatId });
          break;
        }

        default:
          await telegram.sendMessage('Unknown command. Try /status, /report, /stats, /portfolio, /watchlist, /topvolatile, /trades, /pause, /resume, or /health.', { chatId });
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
