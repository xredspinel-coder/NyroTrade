'use strict';

const { money, percent, round } = require('../utils/format');

class PortfolioService {
  constructor({ storage, cache, config, logger }) {
    this.storage = storage;
    this.cache = cache;
    this.config = config;
    this.logger = logger;
    this.localLocks = new Set();
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
      enriched.push({
        ...position,
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

    await this.storage.savePortfolio({ equity });

    return {
      ...base,
      equity,
      positionValue,
      positions: enriched
    };
  }

  async openPosition({ symbol, metrics, sentiment, confidence, reason }) {
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
        const notional = Math.min(cash * this.config.risk.maxTradeFraction, cash);
        if (notional < this.config.risk.minTradeNotional) {
          return { executed: false, reason: 'insufficient paper cash' };
        }

        const price = Number(metrics.price);
        if (!price || price <= 0) return { executed: false, reason: 'invalid price' };

        const fee = notional * this.config.risk.paperFeeRate;
        const quantity = (notional - fee) / price;
        const now = new Date();
        const position = {
          symbol,
          status: 'open',
          quantity,
          entryPrice: price,
          notional,
          entryFee: fee,
          stopLossPrice: price * (1 + this.config.risk.stopLoss),
          takeProfitPrice: price * (1 + this.config.risk.takeProfit),
          confidence,
          sentiment: sentiment ? sentiment.label : 'neutral',
          reason,
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
        await this.storage.setCooldown(
          `buy:${symbol}`,
          this.config.risk.buyCooldownMinutes * 60 * 1000,
          { symbol, type: 'buy' }
        );
        this.logger.trade('Opened paper position', {
          symbol,
          price: metrics.price,
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
