'use strict';

const { clamp, money, percent, round } = require('../utils/format');
const { getStrategyRisk, regimeMultiplier } = require('../strategies/strategyConfig');
const { getStrategyBudget } = require('../strategies/registry');

class PortfolioService {
  constructor({ storage, cache, config, logger }) {
    this.storage = storage;
    this.cache = cache;
    this.config = config;
    this.logger = logger;
    this.localLocks = new Set();
    this.lastPortfolioWriteAt = 0;
    this.lastPortfolioEquity = null;
  }

  async initialize() {
    await this.storage.ensureBootstrap();
    return this.getSnapshot();
  }

  async withLocalLock(key, task) {
    if (this.localLocks.has(key)) {
      return { executed: false, reason: 'local operation already running' };
    }
    this.localLocks.add(key);
    try {
      return await task();
    } finally {
      this.localLocks.delete(key);
    }
  }

  async getSnapshot({ strategyKey } = {}) {
    const [portfolio, positions] = await Promise.all([
      this.storage.getPortfolio(strategyKey),
      this.storage.getOpenPositions(strategyKey)
    ]);

    let positionValue = 0;
    let unrealizedPnl = 0;
    const exposure = {
      meme: 0,
      volatile: 0,
      core: 0,
      other: 0
    };
    const enriched = [];
    for (const position of positions) {
      const ticker = this.cache.getTicker(position.symbol, 0);
      let price = ticker && Number(ticker.last);
      if (!price) {
        const lastKnown = await this.storage.getLastKnownPrice(position.symbol);
        price = lastKnown && Number(lastKnown.price);
      }
      const value = price ? position.quantity * price : position.notional;
      const pnl = price ? value - position.notional : 0;
      positionValue += value;
      unrealizedPnl += pnl;
      const category = position.category || this.getCategory(position.symbol, position.metrics || {});
      exposure[category] = (exposure[category] || 0) + value;
      enriched.push({
        ...position,
        category,
        markPrice: price || position.entryPrice,
        value,
        unrealizedPnl: pnl,
        unrealizedPnlPct: position.notional > 0 ? pnl / position.notional : 0
      });
    }

    const base = portfolio || {
      cash: strategyKey && strategyKey !== 'legacy' ? this.getDefaultBudget(strategyKey) : this.config.risk.paperStartBalance,
      realizedPnl: 0,
      baseSymbol: this.config.exchange.baseSymbol
    };
    const equity = Number(base.cash || 0) + positionValue;
    const exposurePct = Object.entries(exposure).reduce((result, [key, value]) => {
      result[key] = equity > 0 ? value / equity : 0;
      return result;
    }, {});

    const shouldPersist = this.shouldPersistSnapshot(equity);
    if (shouldPersist) {
      await this.storage.savePortfolio({
        equity,
        positionValue,
        unrealizedPnl,
        exposure,
        exposurePct
      }, strategyKey);
      this.lastPortfolioWriteAt = Date.now();
      this.lastPortfolioEquity = equity;
    }

    return {
      ...base,
      equity,
      positionValue,
      unrealizedPnl,
      exposure,
      exposurePct,
      positions: enriched
    };
  }

  shouldPersistSnapshot(equity) {
    if (this.lastPortfolioEquity === null) return true;
    const elapsed = Date.now() - this.lastPortfolioWriteAt;
    const minMs = this.config.storage.portfolioSnapshotMinSeconds * 1000;
    const deltaPct = this.lastPortfolioEquity > 0
      ? Math.abs(equity - this.lastPortfolioEquity) / this.lastPortfolioEquity
      : 1;
    return elapsed >= minMs || deltaPct >= 0.0025;
  }

  getCategory(symbol, metrics = {}) {
    if (Number(metrics.memeScore || 0) >= 0.7) return 'meme';
    if (Number(metrics.volatilityScore || 0) >= 0.65) return 'volatile';
    if (/^(BTC|ETH|BNB|SOL)\//.test(String(symbol || '').toUpperCase())) return 'core';
    return 'other';
  }

  getDefaultBudget(strategyKey) {
    if (strategyKey === 'degensniper' && Number(this.config.degenSniper.budget) > 0) {
      return Number(this.config.degenSniper.budget);
    }
    return getStrategyBudget(strategyKey, this.config.risk.paperStartBalance);
  }

  calculateAllocation({ strategyKey, cash, equity, metrics, confidence, marketRegime }) {
    const strategyRisk = getStrategyRisk(strategyKey, this.config.risk);
    const maxFraction = strategyRisk.maxTradeFraction || this.config.risk.maxTradeFraction;
    const volatilityMultiplier = 1 - Math.min(0.55, Number(metrics.volatilityScore || 0) * 0.35);
    const confidenceMultiplier = 0.45 + Math.min(0.65, Number(confidence || 0));
    const regimeMult = regimeMultiplier(marketRegime, strategyRisk);
    const atrPct = Math.max(Number(metrics.atrPercent || 0), 0.0015);
    const atrPenalty = 1 - Math.min(0.45, atrPct / 0.08);
    const fraction = Math.max(
      0.02,
      Math.min(maxFraction, maxFraction * volatilityMultiplier * confidenceMultiplier * regimeMult * atrPenalty)
    );
    return Math.min(cash, Math.max(this.config.risk.minTradeNotional, equity * fraction));
  }

  async openPosition({
    strategyKey,
    symbol,
    metrics,
    sentiment,
    confidence,
    reason,
    marketRegime,
    notionalOverride,
    source = 'strategy',
    userId = null
  }) {
    const lockKey = `open:${strategyKey || 'legacy'}:${symbol}`;
    return this.withLocalLock(lockKey, async () => {
      const result = await this.storage.db.runTransaction(async (transaction) => {
        const portfolioRef = this.storage.portfolioRef(strategyKey);
        const positionRef = this.storage.positionRef(symbol, strategyKey);
        const [portfolioSnap, positionSnap, openSnap] = await Promise.all([
          transaction.get(portfolioRef),
          transaction.get(positionRef),
          transaction.get(this.storage.positionsCollection().where('status', '==', 'open'))
        ]);

        const portfolio = portfolioSnap.exists ? portfolioSnap.data() : {
          cash: strategyKey && strategyKey !== 'legacy' ? this.getDefaultBudget(strategyKey) : this.config.risk.paperStartBalance,
          realizedPnl: 0,
          equity: strategyKey && strategyKey !== 'legacy' ? this.getDefaultBudget(strategyKey) : this.config.risk.paperStartBalance,
          baseSymbol: this.config.exchange.baseSymbol
        };

        if (positionSnap.exists && positionSnap.data().status === 'open') {
          return { executed: false, reason: 'duplicate open position' };
        }
        const strategyRisk = getStrategyRisk(strategyKey, this.config.risk);
        const openCount = strategyKey
          ? openSnap.docs.filter((doc) => String((doc.data() || {}).strategyKey || 'legacy') === String(strategyKey)).length
          : openSnap.size;
        const maxPositions = strategyRisk.maxOpenPositions || this.config.risk.maxOpenPositions;
        if (openCount >= maxPositions) {
          return { executed: false, reason: 'max open positions reached' };
        }

        const cash = Number(portfolio.cash || 0);
        const equity = Number(portfolio.equity || portfolio.cash || this.config.risk.paperStartBalance);
        const requestedNotional = Number(notionalOverride);
        const notional = Number.isFinite(requestedNotional) && requestedNotional > 0
          ? Math.min(cash, requestedNotional)
          : this.calculateAllocation({
            strategyKey,
            cash,
            equity,
            metrics,
            confidence,
            marketRegime
          });
        if (notional < this.config.risk.minTradeNotional) {
          return { executed: false, reason: 'insufficient paper cash' };
        }

        const price = Number(metrics.price);
        if (!price || price <= 0) return { executed: false, reason: 'invalid price' };

        const fee = notional * this.config.risk.paperFeeRate;
        const quantity = (notional - fee) / price;
        const now = new Date();
        const category = this.getCategory(symbol, metrics);
        // TP/SL are dynamic and strategy-specific; stored fields are informational only.
        const position = {
          symbol,
          strategyKey: strategyKey || 'legacy',
          status: 'open',
          category,
          quantity,
          entryPrice: price,
          notional,
          entryFee: fee,
          stopLossPrice: null,
          takeProfitPrice: null,
          trailingStopPrice: null,
          highestPrice: price,
          confidence,
          sentiment: sentiment ? sentiment.label : 'neutral',
          reason,
          strategy: strategyKey || 'momentum-volume-volatility-confirmed',
          source,
          openedBy: userId,
          marketRegime: marketRegime ? marketRegime.regime : 'unknown',
          metrics,
          openedAt: now,
          updatedAt: now
        };

        transaction.set(positionRef, position, { merge: false });
        transaction.set(portfolioRef, {
          ...portfolio,
          cash: cash - notional,
          updatedAt: now
        }, { merge: true });

        const tradeRef = this.storage.tradesCollection().doc();
        transaction.set(tradeRef, {
          symbol,
          side: 'BUY',
          paper: true,
          price,
          quantity,
          notional,
          fee,
          confidence,
          reason,
          sentiment: sentiment ? sentiment.label : 'neutral',
          strategyKey: strategyKey || 'legacy',
          strategy: strategyKey || 'legacy',
          source,
          amount: notional,
          userId,
          timestamp: now,
          executedAt: now
        });

        return { executed: true, position, tradeId: tradeRef.id };
      });

      if (result.executed) {
        const strategyRisk = getStrategyRisk(strategyKey, this.config.risk);
        const cooldownMs = (strategyRisk.globalTradeCooldownMinutes || this.config.risk.globalTradeCooldownMinutes) * 60 * 1000;
        const symbolCooldownMs = (strategyRisk.symbolTradeCooldownMinutes || this.config.risk.symbolTradeCooldownMinutes) * 60 * 1000;
        const buyCooldownMs = (strategyRisk.buyCooldownMinutes || this.config.risk.buyCooldownMinutes) * 60 * 1000;
        const prefix = strategyKey ? `${strategyKey}:` : '';
        await this.storage.setCooldown(`${prefix}global:trade`, cooldownMs, { type: 'global-trade', strategyKey: strategyKey || 'legacy' });
        await this.storage.setCooldown(`${prefix}trade:${symbol}`, symbolCooldownMs, { symbol, type: 'symbol-trade', strategyKey: strategyKey || 'legacy' });
        await this.storage.setCooldown(
          `${prefix}buy:${symbol}`,
          buyCooldownMs,
          { symbol, type: 'buy', strategyKey: strategyKey || 'legacy' }
        );
        this.logger.trade('Opened paper position', {
          strategyKey: strategyKey || 'legacy',
          symbol,
          price: metrics.price,
          notional: result.position.notional,
          confidence,
          reason
        });
      }

      return result;
    });
  }

  async reducePosition({
    strategyKey,
    symbol,
    fraction = 0.5,
    price,
    metrics,
    sentiment,
    reason,
    source = 'strategy',
    userId = null
  }) {
    const lockKey = `reduce:${strategyKey || 'legacy'}:${symbol}`;
    return this.withLocalLock(lockKey, async () => {
      const result = await this.storage.db.runTransaction(async (transaction) => {
        const portfolioRef = this.storage.portfolioRef(strategyKey);
        const positionRef = this.storage.positionRef(symbol, strategyKey);
        const [portfolioSnap, positionSnap] = await Promise.all([
          transaction.get(portfolioRef),
          transaction.get(positionRef)
        ]);

        if (!positionSnap.exists || positionSnap.data().status !== 'open') {
          return { executed: false, reason: 'position already closed' };
        }

        const portfolio = portfolioSnap.exists ? portfolioSnap.data() : {
          cash: strategyKey && strategyKey !== 'legacy' ? this.getDefaultBudget(strategyKey) : this.config.risk.paperStartBalance,
          realizedPnl: 0,
          equity: strategyKey && strategyKey !== 'legacy' ? this.getDefaultBudget(strategyKey) : this.config.risk.paperStartBalance,
          baseSymbol: this.config.exchange.baseSymbol
        };
        const position = positionSnap.data();
        const exitPrice = Number(price || (metrics && metrics.price));
        if (!exitPrice || exitPrice <= 0) return { executed: false, reason: 'invalid exit price' };

        const sellFraction = clamp(fraction, 0.05, 0.95);
        const quantity = Number(position.quantity || 0) * sellFraction;
        const notionalBasis = Number(position.notional || 0) * sellFraction;
        if (quantity <= 0 || notionalBasis <= 0) {
          return { executed: false, reason: 'invalid partial size' };
        }

        const gross = quantity * exitPrice;
        const fee = gross * this.config.risk.paperFeeRate;
        const proceeds = gross - fee;
        const pnl = proceeds - notionalBasis;
        const pnlPct = notionalBasis > 0 ? pnl / notionalBasis : 0;
        const now = new Date();

        const remainingQuantity = Math.max(0, Number(position.quantity || 0) - quantity);
        const remainingNotional = Math.max(0, Number(position.notional || 0) - notionalBasis);
        const remainingEntryFee = Math.max(0, Number(position.entryFee || 0) - (Number(position.entryFee || 0) * sellFraction));

        transaction.set(positionRef, {
          ...position,
          quantity: remainingQuantity,
          notional: remainingNotional,
          entryFee: remainingEntryFee,
          partialProfitTaken: true,
          partialExitCount: Number(position.partialExitCount || 0) + 1,
          partialRealizedPnl: Number(position.partialRealizedPnl || 0) + pnl,
          lastPartialExitPrice: exitPrice,
          lastPartialExitAt: now,
          updatedAt: now
        }, { merge: false });

        transaction.set(portfolioRef, {
          ...portfolio,
          cash: Number(portfolio.cash || 0) + proceeds,
          realizedPnl: Number(portfolio.realizedPnl || 0) + pnl,
          updatedAt: now
        }, { merge: true });

        const tradeRef = this.storage.tradesCollection().doc();
        transaction.set(tradeRef, {
          symbol,
          side: 'SELL',
          paper: true,
          partial: true,
          price: exitPrice,
          quantity,
          notional: gross,
          fee,
          pnl,
          pnlPct,
          reason,
          sentiment: sentiment ? sentiment.label : 'neutral',
          strategyKey: strategyKey || 'legacy',
          strategy: strategyKey || 'legacy',
          source,
          userId,
          timestamp: now,
          executedAt: now
        });

        return {
          executed: true,
          position: {
            ...position,
            quantity: remainingQuantity,
            notional: remainingNotional,
            closedQuantity: quantity,
            closedNotional: gross,
            realizedPnl: pnl,
            realizedPnlPct: pnlPct
          },
          tradeId: tradeRef.id
        };
      });

      if (result.executed) {
        this.logger.trade('Reduced paper position', {
          strategyKey: strategyKey || 'legacy',
          symbol,
          price,
          reason,
          pnl: result.position.realizedPnl,
          pnlPct: result.position.realizedPnlPct
        });
      }

      return result;
    });
  }

  async closePosition({ strategyKey, symbol, price, metrics, sentiment, reason, source = 'strategy', userId = null }) {
    const lockKey = `close:${strategyKey || 'legacy'}:${symbol}`;
    return this.withLocalLock(lockKey, async () => {
      const result = await this.storage.db.runTransaction(async (transaction) => {
        const portfolioRef = this.storage.portfolioRef(strategyKey);
        const positionRef = this.storage.positionRef(symbol, strategyKey);
        const [portfolioSnap, positionSnap] = await Promise.all([
          transaction.get(portfolioRef),
          transaction.get(positionRef)
        ]);

        if (!positionSnap.exists || positionSnap.data().status !== 'open') {
          return { executed: false, reason: 'position already closed' };
        }

        const portfolio = portfolioSnap.exists ? portfolioSnap.data() : {
          cash: strategyKey && strategyKey !== 'legacy' ? this.getDefaultBudget(strategyKey) : this.config.risk.paperStartBalance,
          realizedPnl: 0,
          equity: strategyKey && strategyKey !== 'legacy' ? this.getDefaultBudget(strategyKey) : this.config.risk.paperStartBalance,
          baseSymbol: this.config.exchange.baseSymbol
        };
        const position = positionSnap.data();
        const exitPrice = Number(price || (metrics && metrics.price));
        if (!exitPrice || exitPrice <= 0) return { executed: false, reason: 'invalid exit price' };

        const gross = position.quantity * exitPrice;
        const fee = gross * this.config.risk.paperFeeRate;
        const proceeds = gross - fee;
        const pnl = proceeds - position.notional;
        const pnlPct = position.notional > 0 ? pnl / position.notional : 0;
        const now = new Date();

        transaction.set(positionRef, {
          ...position,
          status: 'closed',
          exitPrice,
          exitFee: fee,
          exitValue: proceeds,
          realizedPnl: pnl,
          realizedPnlPct: pnlPct,
          closeReason: reason,
          closeMetrics: metrics,
          closedAt: now,
          updatedAt: now
        }, { merge: false });

        transaction.set(portfolioRef, {
          ...portfolio,
          cash: Number(portfolio.cash || 0) + proceeds,
          realizedPnl: Number(portfolio.realizedPnl || 0) + pnl,
          updatedAt: now
        }, { merge: true });

        const tradeRef = this.storage.tradesCollection().doc();
        transaction.set(tradeRef, {
          symbol,
          side: 'SELL',
          paper: true,
          price: exitPrice,
          quantity: position.quantity,
          notional: gross,
          fee,
          pnl,
          pnlPct,
          reason,
          sentiment: sentiment ? sentiment.label : 'neutral',
          strategyKey: strategyKey || 'legacy',
          strategy: strategyKey || 'legacy',
          source,
          userId,
          timestamp: now,
          executedAt: now
        });

        return {
          executed: true,
          position: {
            ...position,
            exitPrice,
            realizedPnl: pnl,
            realizedPnlPct: pnlPct
          },
          tradeId: tradeRef.id
        };
      });

      if (result.executed) {
        const strategyRisk = getStrategyRisk(strategyKey, this.config.risk);
        const cooldownMs = (strategyRisk.globalTradeCooldownMinutes || this.config.risk.globalTradeCooldownMinutes) * 60 * 1000;
        const symbolCooldownMs = (strategyRisk.symbolTradeCooldownMinutes || this.config.risk.symbolTradeCooldownMinutes) * 60 * 1000;
        const buyCooldownMs = (strategyRisk.buyCooldownMinutes || this.config.risk.buyCooldownMinutes) * 60 * 1000;
        const prefix = strategyKey ? `${strategyKey}:` : '';
        await this.storage.setCooldown(`${prefix}global:trade`, cooldownMs, { type: 'global-trade', strategyKey: strategyKey || 'legacy' });
        await this.storage.setCooldown(`${prefix}trade:${symbol}`, symbolCooldownMs, { symbol, type: 'symbol-trade', strategyKey: strategyKey || 'legacy' });
        await this.storage.setCooldown(
          `${prefix}buy:${symbol}`,
          buyCooldownMs,
          { symbol, type: 'post-sell', strategyKey: strategyKey || 'legacy' }
        );
        this.logger.trade('Closed paper position', {
          strategyKey: strategyKey || 'legacy',
          symbol,
          price,
          reason,
          pnl: result.position.realizedPnl,
          pnlPct: result.position.realizedPnlPct
        });
      }

      return result;
    });
  }

  async updatePositionRiskState(symbol, patch, strategyKey) {
    if (!patch || Object.keys(patch).length === 0) return;
    await this.storage.positionRef(symbol, strategyKey).set({
      ...patch,
      updatedAt: new Date()
    }, { merge: true });
  }

  async reset() {
    await this.storage.resetPaperPortfolio();
    this.logger.system('Paper portfolio reset');
    return this.getSnapshot();
  }

  async getRecentTrades(limit = 10) {
    return this.storage.getRecentTrades(limit);
  }

  formatSnapshot(snapshot) {
    const base = this.config.exchange.baseSymbol;
    const lines = [
      'NyroTrade portfolio',
      `Cash: ${money(snapshot.cash, base)}`,
      `Equity: ${money(snapshot.equity, base)}`,
      `Open value: ${money(snapshot.positionValue, base)}`,
      `Realized PnL: ${money(snapshot.realizedPnl || 0, base)}`,
      `Unrealized PnL: ${money(snapshot.unrealizedPnl || 0, base)}`,
      `Meme exposure: ${percent((snapshot.exposurePct && snapshot.exposurePct.meme) || 0)}`,
      `Open positions: ${snapshot.positions.length}`
    ];

    for (const position of snapshot.positions) {
      lines.push(
        `${position.symbol}: ${round(position.quantity, 6)} @ ${round(position.entryPrice, 8)} | PnL ${money(position.unrealizedPnl, base)} (${percent(position.unrealizedPnlPct)})`
      );
    }

    return lines.join('\n');
  }
}

module.exports = PortfolioService;
