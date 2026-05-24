'use strict';

class TradingStrategy {
  constructor({
    analyzer,
    risk,
    portfolio,
    sentiment,
    scanner,
    storage,
    exchange,
    alerts,
    marketRegime,
    config,
    logger
  }) {
    this.analyzer = analyzer;
    this.risk = risk;
    this.portfolio = portfolio;
    this.sentiment = sentiment;
    this.scanner = scanner;
    this.storage = storage;
    this.exchange = exchange;
    this.alerts = alerts;
    this.marketRegime = marketRegime;
    this.config = config;
    this.logger = logger;
    this.running = false;
  }

  async runOnce({ source = 'scheduler' } = {}) {
    if (this.running) {
      this.logger.warn('Strategy tick skipped because previous tick is still running', { source });
      return { skipped: true };
    }

    this.running = true;
    try {
      const settings = await this.storage.getSettings();
      await this.manageOpenPositions();
      if (settings.paused) {
        return { paused: true };
      }
      const signals = await this.findEntries(settings);
      return { paused: false, signals };
    } finally {
      this.running = false;
    }
  }

  async manageOpenPositions() {
    const positions = await this.storage.getOpenPositions();
    for (const position of positions) {
      try {
        const metrics = await this.analyzer.analyzeSymbol(position.symbol);
        const symbolSentiment = await this.sentiment.getSentiment(position.symbol);
        const decision = this.risk.getSellReason({
          position,
          metrics,
          sentiment: symbolSentiment
        });

        if (decision.positionPatch && this.hasPositionPatchChanged(position, decision.positionPatch)) {
          await this.portfolio.updatePositionRiskState(position.symbol, decision.positionPatch);
        }

        if (!decision.shouldSell) continue;

        const result = await this.portfolio.closePosition({
          symbol: position.symbol,
          price: metrics.price,
          metrics,
          sentiment: symbolSentiment,
          reason: decision.reason
        });

        if (result.executed) {
          await this.alerts.sendTradeAlert({
            side: 'SELL',
            symbol: position.symbol,
            price: metrics.price,
            quantity: result.position.quantity,
            notional: result.position.quantity * metrics.price,
            pnl: result.position.realizedPnl,
            pnlPct: result.position.realizedPnlPct,
            reason: decision.reason
          });
        }
      } catch (error) {
        this.logger.error('Failed to manage open position', {
          symbol: position.symbol,
          error
        });
      }
    }
  }

  async findEntries(settings) {
    const watchlist = await this.scanner.getWatchlist();
    const openPositions = await this.storage.getOpenPositions();
    const openBySymbol = new Map(openPositions.map((position) => [position.symbol, position]));
    const [snapshot, marketRegime, diagnostics] = await Promise.all([
      this.portfolio.getSnapshot(),
      this.marketRegime.getCurrent().catch(() => null),
      this.storage.getStrategyDiagnostics().catch(() => null)
    ]);
    const signals = [];

    await this.exchange.getTickers(watchlist);

    for (const symbol of watchlist) {
      try {
        const market = this.exchange.cache.getMarket(symbol);
        const existingPosition = openBySymbol.get(symbol);
        const metrics = await this.analyzer.analyzeSymbol(symbol);
        const symbolSentiment = await this.sentiment.getSentiment(symbol);
        const decision = await this.risk.canBuy({
          symbol,
          market,
          metrics,
          sentiment: symbolSentiment,
          openPositions,
          existingPosition,
          settings,
          snapshot,
          marketRegime,
          diagnostics
        });

        if (!decision.allowed) {
          continue;
        }

        const aiAssist = await this.sentiment.getAiSignalAssist({
          symbol,
          metrics,
          sentiment: symbolSentiment
        });
        if (this.config.sentiment.aiRankingEnabled && aiAssist.score < 0.35) {
          this.logger.signal('Signal rejected by optional AI assist filter', {
            symbol,
            score: aiAssist.score,
            reason: aiAssist.reason
          });
          continue;
        }

        const reason = [
          'positive momentum',
          'volume spike confirmed',
          'high volatility score',
          `${symbolSentiment.label} sentiment`,
          `assist ${Math.round(aiAssist.score * 100)}%`
        ].join(', ');

        const result = await this.portfolio.openPosition({
          symbol,
          metrics,
          sentiment: symbolSentiment,
          confidence: decision.confidence,
          reason,
          marketRegime
        });

        if (!result.executed) {
          this.logger.warn('Paper buy rejected by portfolio layer', {
            symbol,
            reason: result.reason
          });
          continue;
        }

        openPositions.push(result.position);
        signals.push({ symbol, metrics, confidence: decision.confidence, reason });
        await this.alerts.sendSignalAlert({
          symbol,
          metrics,
          confidence: decision.confidence,
          stopLossPrice: result.position.stopLossPrice,
          takeProfitPrice: result.position.takeProfitPrice,
          reason
        });
        await this.alerts.sendTradeAlert({
          side: 'BUY',
          symbol,
          price: metrics.price,
          quantity: result.position.quantity,
          notional: result.position.notional,
          reason
        });
      } catch (error) {
        this.logger.error('Failed to evaluate strategy entry', {
          symbol,
          error
        });
      }
    }

    return signals;
  }

  hasPositionPatchChanged(position, patch) {
    return Object.entries(patch).some(([key, value]) => {
      const current = Number(position[key] || 0);
      const next = Number(value || 0);
      if (!Number.isFinite(current) || !Number.isFinite(next)) return position[key] !== value;
      return Math.abs(current - next) / Math.max(Math.abs(next), 1) > 0.0005;
    });
  }
}

module.exports = TradingStrategy;
