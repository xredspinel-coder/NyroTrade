'use strict';

const { clamp, money, percent, round, toMillis } = require('../utils/format');

function mean(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length === 0) return 0;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function stddev(values) {
  const avg = mean(values);
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length < 2) return 0;
  return Math.sqrt(mean(filtered.map((value) => (value - avg) ** 2)));
}

class AnalyticsService {
  constructor({ storage, portfolio, config, logger }) {
    this.storage = storage;
    this.portfolio = portfolio;
    this.config = config;
    this.logger = logger;
  }

  async refresh() {
    const analytics = await this.computeAll();
    await this.storage.saveAnalyticsSnapshot(analytics);
    await this.storage.saveStrategyDiagnostics(analytics.strategyDiagnostics);
    this.logger.info('Analytics snapshot refreshed', {
      totalTrades: analytics.totalTrades,
      winRate: analytics.winRate,
      realizedPnl: analytics.totalRealizedPnl
    });
    return analytics;
  }

  async getLatestOrCompute() {
    const latest = await this.storage.getLatestAnalytics();
    if (latest) return latest;
    return this.refresh();
  }

  async computeAll() {
    const strategyKeys = ['wavehunter', 'momentumpulse', 'whaleshadow', 'sentinelmind'];
    const [overall, byStrategy, regime] = await Promise.all([
      this.compute(),
      Promise.all(strategyKeys.map(async (strategyKey) => {
        const computed = await this.compute({ strategyKey });
        await this.storage.saveStrategyAnalyticsSnapshot(strategyKey, computed).catch(() => undefined);
        return computed;
      })),
      this.storage.getMarketRegime().catch(() => null)
    ]);

    const comparison = byStrategy.map((row) => ({
      strategyKey: row.strategyKey,
      winRate: row.winRate,
      profitFactor: row.profitFactor,
      expectancy: row.expectancy,
      maxDrawdown: row.maxDrawdown,
      totalRealizedPnl: row.totalRealizedPnl
    }));

    return {
      ...overall,
      marketRegime: regime ? regime.regime : 'unknown',
      strategies: comparison,
      byStrategy: byStrategy.reduce((acc, row) => {
        acc[row.strategyKey] = row;
        return acc;
      }, {})
    };
  }

  async compute({ strategyKey } = {}) {
    const [trades, closedPositions, snapshot, regime] = await Promise.all([
      this.storage.getTrades(500, strategyKey),
      this.storage.getClosedPositions(250, strategyKey),
      this.portfolio.getSnapshot(strategyKey ? { strategyKey } : undefined),
      this.storage.getMarketRegime().catch(() => null)
    ]);

    const buys = trades.filter((trade) => trade.side === 'BUY');
    const sells = trades.filter((trade) => trade.side === 'SELL');
    const realized = sells.map((trade) => Number(trade.pnl || 0));
    const winners = realized.filter((pnl) => pnl > 0);
    const losers = realized.filter((pnl) => pnl < 0);
    const totalWin = winners.reduce((sum, pnl) => sum + pnl, 0);
    const totalLoss = losers.reduce((sum, pnl) => sum + pnl, 0);
    const averageProfit = mean(winners);
    const averageLoss = mean(losers);
    const winRate = sells.length > 0 ? winners.length / sells.length : 0;
    const lossRate = sells.length > 0 ? losers.length / sells.length : 0;
    const profitFactor = Math.abs(totalLoss) > 0 ? totalWin / Math.abs(totalLoss) : (totalWin > 0 ? totalWin : 0);
    const expectancy = (winRate * averageProfit) + (lossRate * averageLoss);
    const returns = sells.map((trade) => Number(trade.pnlPct || 0)).filter((value) => Number.isFinite(value));
    const sharpeLikeRatio = stddev(returns) > 0 ? mean(returns) / stddev(returns) : 0;

    const sortedSells = sells.slice().sort((a, b) => toMillis(a.executedAt) - toMillis(b.executedAt));
    let equity = strategyKey ? (this.config.risk.paperStartBalance / 4) : this.config.risk.paperStartBalance;
    let peak = equity;
    let maxDrawdown = 0;
    for (const trade of sortedSells) {
      equity += Number(trade.pnl || 0);
      peak = Math.max(peak, equity);
      const drawdown = peak > 0 ? (peak - equity) / peak : 0;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }

    const streak = this.currentStreak(sortedSells);
    const symbolStats = this.bySymbol(sells);
    const bestSymbol = symbolStats[0] || null;
    const worstSymbol = symbolStats.slice().sort((a, b) => a.pnl - b.pnl)[0] || null;
    const holdDurations = closedPositions
      .map((position) => {
        const opened = toMillis(position.openedAt);
        const closed = toMillis(position.closedAt);
        return opened && closed && closed > opened ? (closed - opened) / 1000 : null;
      })
      .filter((value) => value !== null);

    const recentSells = sortedSells.slice(-20);
    const recentWins = recentSells.filter((trade) => Number(trade.pnl || 0) > 0).length;
    const recentWinRate = recentSells.length > 0 ? recentWins / recentSells.length : 0;
    const oldestTradeMs = trades.length > 0
      ? Math.min(...trades.map((trade) => toMillis(trade.executedAt)).filter(Boolean))
      : Date.now();
    const elapsedDays = Math.max(1 / 24, (Date.now() - oldestTradeMs) / (24 * 60 * 60 * 1000));
    const tradeFrequencyPerDay = trades.length / elapsedDays;
    const falseBreakoutFrequency = closedPositions.length > 0
      ? closedPositions.filter((position) => /fake|breakout|reversal|stop loss/i.test(String(position.closeReason || ''))).length / closedPositions.length
      : 0;
    const overtradingScore = clamp(tradeFrequencyPerDay / 24, 0, 1);
    const unstableMarketScore = regime ? Number(regime.chaosScore || 0) : 0;
    const strategyHealthScore = clamp(
      0.45
        + (recentWinRate - 0.5) * 0.35
        + clamp(profitFactor / 2, 0, 0.25)
        - clamp(maxDrawdown, 0, 0.3)
        - (falseBreakoutFrequency * 0.15)
        - (overtradingScore * 0.1)
        - (unstableMarketScore > 0.75 ? 0.08 : 0),
      0,
      1
    );

    return {
      strategyKey: strategyKey || 'legacy',
      totalTrades: trades.length,
      totalBuys: buys.length,
      totalSells: sells.length,
      winRate,
      lossRate,
      averageProfit,
      averageLoss,
      largestWin: winners.length ? Math.max(...winners) : 0,
      largestLoss: losers.length ? Math.min(...losers) : 0,
      profitFactor,
      expectancy,
      maxDrawdown,
      currentStreak: streak,
      bestSymbol,
      worstSymbol,
      averageHoldSeconds: mean(holdDurations),
      totalRealizedPnl: Number(snapshot.realizedPnl || 0),
      unrealizedPnl: snapshot.unrealizedPnl || 0,
      sharpeLikeRatio,
      tradeFrequencyPerDay,
      recentWinRate,
      strategyDiagnostics: {
        strategyHealthScore,
        tradeSuccessBySymbol: symbolStats,
        overtradingScore,
        falseBreakoutFrequency,
        unstableMarketScore,
        marketRegime: regime ? regime.regime : 'unknown',
        recentWinRate,
        profitFactor,
        maxDrawdown
      }
    };
  }

  currentStreak(sortedSells) {
    let count = 0;
    let type = 'none';
    for (const trade of sortedSells.slice().reverse()) {
      const pnl = Number(trade.pnl || 0);
      const nextType = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'flat';
      if (type === 'none') type = nextType;
      if (nextType !== type) break;
      count += 1;
    }
    return { type, count };
  }

  bySymbol(sells) {
    const stats = new Map();
    for (const trade of sells) {
      const current = stats.get(trade.symbol) || {
        symbol: trade.symbol,
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0
      };
      const pnl = Number(trade.pnl || 0);
      current.trades += 1;
      current.pnl += pnl;
      if (pnl > 0) current.wins += 1;
      if (pnl < 0) current.losses += 1;
      current.winRate = current.trades > 0 ? current.wins / current.trades : 0;
      stats.set(trade.symbol, current);
    }
    return Array.from(stats.values()).sort((a, b) => b.pnl - a.pnl);
  }

  formatStats(analytics) {
    const base = this.config.exchange.baseSymbol;
    const streak = analytics.currentStreak || { type: 'none', count: 0 };
    const startBalance = analytics.strategyKey && analytics.strategyKey !== 'legacy'
      ? this.config.risk.paperStartBalance / 4
      : this.config.risk.paperStartBalance;
    const pnlPct = startBalance > 0 ? (Number(analytics.totalRealizedPnl || 0) / startBalance) : 0;
    const label = analytics.strategyKey && analytics.strategyKey !== 'legacy'
      ? `${analytics.strategyKey} performance`
      : 'NyroTrade performance stats';
    return [
      label,
      `Trades: ${analytics.totalTrades} (${analytics.totalBuys} buys / ${analytics.totalSells} sells)`,
      `Win rate: ${percent(analytics.winRate)} | Loss rate: ${percent(analytics.lossRate)}`,
      `Average profit: ${money(analytics.averageProfit, base)}`,
      `Average loss: ${money(analytics.averageLoss, base)}`,
      `Largest win: ${money(analytics.largestWin, base)}`,
      `Largest loss: ${money(analytics.largestLoss, base)}`,
      `Profit factor: ${round(analytics.profitFactor, 3)}`,
      `Expectancy: ${money(analytics.expectancy, base)}`,
      `Max drawdown: ${percent(analytics.maxDrawdown)}`,
      `Current streak: ${streak.count} ${streak.type}`,
      `Best symbol: ${analytics.bestSymbol ? `${analytics.bestSymbol.symbol} ${money(analytics.bestSymbol.pnl, base)}` : 'n/a'}`,
      `Worst symbol: ${analytics.worstSymbol ? `${analytics.worstSymbol.symbol} ${money(analytics.worstSymbol.pnl, base)}` : 'n/a'}`,
      `Average hold: ${round((analytics.averageHoldSeconds || 0) / 3600, 2)}h`,
      `Realized PnL: ${money(analytics.totalRealizedPnl, base)} (${percent(pnlPct)})`,
      `Unrealized PnL: ${money(analytics.unrealizedPnl || 0, base)}`,
      `Sharpe-like ratio: ${round(analytics.sharpeLikeRatio, 3)}`,
      `Trade frequency: ${round(analytics.tradeFrequencyPerDay, 2)}/day`,
      `Strategy health: ${percent((analytics.strategyDiagnostics || {}).strategyHealthScore || 0)}`
    ].join('\n');
  }

  formatStrategyComparison(analytics, baseSymbol) {
    const rows = (analytics && analytics.strategies) || [];
    if (!rows.length) return 'No strategy stats yet.';
    const perStrategy = startBalance => (row) => {
      const pnlPct = startBalance > 0 ? (Number(row.totalRealizedPnl || 0) / startBalance) : 0;
      return `${row.strategyKey}: ${percent(pnlPct)} | win ${percent(row.winRate || 0)} | PF ${round(row.profitFactor || 0, 2)} | DD ${percent(row.maxDrawdown || 0)}`;
    };
    const start = this.config.risk.paperStartBalance / 4;
    return rows.map((row) => {
      const name = row.strategyKey;
      const pnl = money(row.totalRealizedPnl || 0, baseSymbol);
      const pnlPct = start > 0 ? percent((Number(row.totalRealizedPnl || 0) / start)) : '0%';
      return `${name}: ${pnl} (${pnlPct}) | win ${percent(row.winRate || 0)} | PF ${round(row.profitFactor || 0, 2)} | DD ${percent(row.maxDrawdown || 0)}`;
    }).join('\n');
  }
}

module.exports = AnalyticsService;
