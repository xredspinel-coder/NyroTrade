'use strict';

class MomentumPulseAgent {
  constructor(services) {
    this.analyzer = services.analyzer;
    this.risk = services.risk;
    this.portfolio = services.portfolio;
    this.sentiment = services.sentiment;
    this.scanner = services.scanner;
    this.storage = services.storage;
    this.exchange = services.exchange;
    this.alerts = services.alerts;
    this.marketRegime = services.marketRegime;
    this.config = services.config;
    this.logger = services.logger;
    this.strategyKey = 'momentumpulse';
  }

  async tick({ source = 'scheduler' } = {}) {
    await this.manageOpenPositions();
    const settings = await this.storage.strategySettingsRef(this.strategyKey).get().then((snap) => (snap.exists ? snap.data() : { paused: false }));
    if (settings.paused) return { paused: true, signals: [] };
    const signals = await this.findEntries(settings, source);
    return { paused: false, signals };
  }

  async manageOpenPositions() {
    const positions = await this.storage.getOpenPositions(this.strategyKey);
    for (const position of positions) {
      try {
        const metrics = await this.analyzer.analyzeSymbol(position.symbol);
        const symbolSentiment = await this.sentiment.getSentiment(position.symbol);
        const decision = this.risk.getSellReason({
          position,
          metrics,
          sentiment: symbolSentiment,
          strategyKey: this.strategyKey
        });

        if (decision.positionPatch) {
          await this.portfolio.updatePositionRiskState(position.symbol, decision.positionPatch, this.strategyKey);
        }

        if (!decision.shouldSell) continue;

        const result = await this.portfolio.closePosition({
          strategyKey: this.strategyKey,
          symbol: position.symbol,
          price: metrics.price,
          metrics,
          sentiment: symbolSentiment,
          reason: decision.reason
        });

        if (result.executed) {
          await this.alerts.sendTradeAlert({
            strategyKey: this.strategyKey,
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
        this.logger.error('MomentumPulse failed to manage open position', {
          symbol: position.symbol,
          error
        });
      }
    }
  }

  async findEntries(settings, source) {
    const watchlist = await this.scanner.getWatchlist();
    const openPositions = await this.storage.getOpenPositions(this.strategyKey);
    const openBySymbol = new Map(openPositions.map((position) => [position.symbol, position]));
    const [snapshot, marketRegime, diagnostics] = await Promise.all([
      this.portfolio.getSnapshot({ strategyKey: this.strategyKey }),
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
          strategyKey: this.strategyKey,
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

        if (!decision.allowed) continue;

        const aiAssist = await this.sentiment.getAiSignalAssist({
          symbol,
          metrics,
          sentiment: symbolSentiment
        });
        if (this.config.sentiment.aiRankingEnabled && aiAssist.score < 0.35) {
          this.logger.signal('MomentumPulse signal rejected by optional AI assist filter', {
            source,
            symbol,
            score: aiAssist.score,
            reason: aiAssist.reason
          });
          continue;
        }

        const reason = [
          'momentum pulse',
          'breakout validated',
          'trend confirmed',
          `${symbolSentiment.label} sentiment`,
          `assist ${Math.round(aiAssist.score * 100)}%`
        ].join(', ');

        const result = await this.portfolio.openPosition({
          strategyKey: this.strategyKey,
          symbol,
          metrics,
          sentiment: symbolSentiment,
          confidence: decision.confidence,
          reason,
          marketRegime
        });

        if (!result.executed) continue;

        openPositions.push(result.position);
        signals.push({ symbol, metrics, confidence: decision.confidence, reason });

        await this.alerts.sendSignalAlert({
          strategyKey: this.strategyKey,
          symbol,
          metrics,
          confidence: decision.confidence,
          stopLossPrice: result.position.stopLossPrice,
          takeProfitPrice: result.position.takeProfitPrice,
          reason
        });
        await this.alerts.sendTradeAlert({
          strategyKey: this.strategyKey,
          side: 'BUY',
          symbol,
          price: metrics.price,
          quantity: result.position.quantity,
          notional: result.position.notional,
          reason
        });
      } catch (error) {
        this.logger.error('MomentumPulse failed to evaluate entry', { symbol, error });
      }
    }

    return signals;
  }
}

module.exports = MomentumPulseAgent;

