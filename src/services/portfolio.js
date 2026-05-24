'use strict';

const { money, percent, round } = require('../utils/format');

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

  async getSnapshot() {
    const [portfolio, positions] = await Promise.all([
      this.storage.getPortfolio(),
      this.storage.getOpenPositions()
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
      cash: this.config.risk.paperStartBalance,
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
      });
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

  calculateAllocation({ cash, equity, metrics, confidence, marketRegime }) {
    const maxFraction = this.config.risk.maxTradeFraction;
    const volatilityMultiplier = 1 - Math.min(0.55, Number(metrics.volatilityScore || 0) * 0.35);
    const confidenceMultiplier = 0.45 + Math.min(0.65, Number(confidence || 0));
    const regimeMultiplier = marketRegime ? Number(marketRegime.aggressiveness || 0.55) : 0.55;
    const atrPenalty = 1 - Math.min(0.45, Number(metrics.atrPercent || 0) / 0.08);
    const fraction = Math.max(
      0.02,
      Math.min(maxFraction, maxFraction * volatilityMultiplier * confidenceMultiplier * regimeMultiplier * atrPenalty)
    );
    return Math.min(cash, Math.max(this.config.risk.minTradeNotional, equity * fraction));
  }

  async openPosition({ symbol, metrics, sentiment, confidence, reason, marketRegime }) {
    return this.withLocalLock(`open:${symbol}`, async () => {
      const result = await this.storage.db.runTransaction(async (transaction) => {
        const portfolioRef = this.storage.portfolioRef();
        const positionRef = this.storage.positionRef(symbol);
        const [portfolioSnap, positionSnap, openSnap] = await Promise.all([
          transaction.get(portfolioRef),
          transaction.get(positionRef),
          transaction.get(this.storage.positionsCollection().where('status', '==', 'open'))
        ]);

        const portfolio = portfolioSnap.exists ? portfolioSnap.data() : {
          cash: this.config.risk.paperStartBalance,
          realizedPnl: 0,
          equity: this.config.risk.paperStartBalance,
          baseSymbol: this.config.exchange.baseSymbol
        };

        if (positionSnap.exists && positionSnap.data().status === 'open') {
          return { executed: false, reason: 'duplicate open position' };
        }
        if (openSnap.size >= this.config.risk.maxOpenPositions) {
          return { executed: false, reason: 'max open positions reached' };
        }

        const cash = Number(portfolio.cash || 0);
        const equity = Number(portfolio.equity || portfolio.cash || this.config.risk.paperStartBalance);
        const notional = this.calculateAllocation({
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
        const position = {
          symbol,
          status: 'open',
          category,
          quantity,
          entryPrice: price,
          notional,
          entryFee: fee,
          stopLossPrice: price * (1 + this.config.risk.stopLoss),
          takeProfitPrice: price * (1 + this.config.risk.takeProfit),
          trailingStopPrice: null,
          highestPrice: price,
          confidence,
          sentiment: sentiment ? sentiment.label : 'neutral',
          reason,
          strategy: 'momentum-volume-volatility-confirmed',
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
          executedAt: now
        });

        return { executed: true, position, tradeId: tradeRef.id };
      });

      if (result.executed) {
        const cooldownMs = this.config.risk.globalTradeCooldownMinutes * 60 * 1000;
        const symbolCooldownMs = this.config.risk.symbolTradeCooldownMinutes * 60 * 1000;
        await this.storage.setCooldown('global:trade', cooldownMs, { type: 'global-trade' });
        await this.storage.setCooldown(`trade:${symbol}`, symbolCooldownMs, { symbol, type: 'symbol-trade' });
        await this.storage.setCooldown(
          `buy:${symbol}`,
          this.config.risk.buyCooldownMinutes * 60 * 1000,
          { symbol, type: 'buy' }
        );
        this.logger.trade('Opened paper position', {
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

  async closePosition({ symbol, price, metrics, sentiment, reason }) {
    return this.withLocalLock(`close:${symbol}`, async () => {
      const result = await this.storage.db.runTransaction(async (transaction) => {
        const portfolioRef = this.storage.portfolioRef();
        const positionRef = this.storage.positionRef(symbol);
        const [portfolioSnap, positionSnap] = await Promise.all([
          transaction.get(portfolioRef),
          transaction.get(positionRef)
        ]);

        if (!positionSnap.exists || positionSnap.data().status !== 'open') {
          return { executed: false, reason: 'position already closed' };
        }

        const portfolio = portfolioSnap.exists ? portfolioSnap.data() : {
          cash: this.config.risk.paperStartBalance,
          realizedPnl: 0,
          equity: this.config.risk.paperStartBalance,
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
        const cooldownMs = this.config.risk.globalTradeCooldownMinutes * 60 * 1000;
        const symbolCooldownMs = this.config.risk.symbolTradeCooldownMinutes * 60 * 1000;
        await this.storage.setCooldown('global:trade', cooldownMs, { type: 'global-trade' });
        await this.storage.setCooldown(`trade:${symbol}`, symbolCooldownMs, { symbol, type: 'symbol-trade' });
        await this.storage.setCooldown(
          `buy:${symbol}`,
          this.config.risk.buyCooldownMinutes * 60 * 1000,
          { symbol, type: 'post-sell' }
        );
        this.logger.trade('Closed paper position', {
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

  async updatePositionRiskState(symbol, patch) {
    if (!patch || Object.keys(patch).length === 0) return;
    await this.storage.positionRef(symbol).set({
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
