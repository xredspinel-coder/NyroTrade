'use strict';

const { clamp } = require('../../utils/format');

class WhaleShadowAgent {
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
    this.whaleIntel = services.whaleIntel;
    this.config = services.config;
    this.logger = services.logger;
    this.strategyKey = 'whaleshadow';
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

        // Use existing trailing-stop logic; WhaleShadow exits sooner on flow decay.
        const baseDecision = this.risk.getSellReason({
          position,
          metrics,
          sentiment: symbolSentiment,
          strategyKey: this.strategyKey
        });
        const flowDecay = Number(metrics.volumeRatio || 0) < 0.95 && Number(metrics.recentMomentum || 0) < 0.001;
        const shouldSell = baseDecision.shouldSell || (flowDecay && Number(metrics.bearishConfirmationCandles || 0) >= 1);
        const reason = baseDecision.shouldSell ? baseDecision.reason : 'flow decay confirmed';

        if (baseDecision.positionPatch) {
          await this.portfolio.updatePositionRiskState(position.symbol, baseDecision.positionPatch, this.strategyKey);
        }
        if (!shouldSell) continue;

        const result = await this.portfolio.closePosition({
          strategyKey: this.strategyKey,
          symbol: position.symbol,
          price: metrics.price,
          metrics,
          sentiment: symbolSentiment,
          reason
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
            reason
          });
        }
      } catch (error) {
        this.logger.error('WhaleShadow failed to manage open position', { symbol: position.symbol, error });
      }
    }
  }

  async findEntries(settings, source) {
    const watchlist = await this.scanner.getWatchlist();
    const openPositions = await this.storage.getOpenPositions(this.strategyKey);
    const openBySymbol = new Map(openPositions.map((position) => [position.symbol, position]));
    const [snapshot, marketRegime] = await Promise.all([
      this.portfolio.getSnapshot({ strategyKey: this.strategyKey }),
      this.marketRegime.getCurrent().catch(() => null)
    ]);
    const signals = [];

    await this.exchange.getTickers(watchlist);

    for (const symbol of watchlist) {
      try {
        if (openBySymbol.get(symbol)) continue;
        const market = this.exchange.cache.getMarket(symbol);
        const metrics = await this.analyzer.analyzeSymbol(symbol);
        const symbolSentiment = await this.sentiment.getSentiment(symbol);
        const whale = await this.whaleIntel.getSignal(symbol, metrics);
        const strategyRisk = this.risk.getStrategyConfig(this.strategyKey);
        const minScore = strategyRisk.whaleCredibilityMinScore || strategyRisk.minWhaleScore || 0.62;

        if (!whale.credible || whale.score < minScore) continue;
        if (whale.credibility && whale.credibility.whaleDistribution > whale.credibility.whaleAccumulation) continue;
        if (whale.credibility && whale.credibility.exchangeWalletDetection >= 0.7) continue;
        if (whale.credibility && whale.credibility.marketMakerFiltering >= 0.7) continue;
        if (marketRegime && marketRegime.regime === 'low_liquidity') continue;
        if (metrics.memeScore >= 0.85) continue;

        const decision = await this.risk.canBuy({
          strategyKey: this.strategyKey,
          symbol,
          market,
          metrics,
          sentiment: symbolSentiment,
          openPositions,
          existingPosition: null,
          settings,
          snapshot,
          marketRegime,
          diagnostics: null
        });
        if (!decision.allowed) continue;

        const confidence = clamp(decision.confidence * 0.55 + whale.score * 0.45, 0, 1);
        const credibility = whale.credibility || {};
        const reason = [
          'high-credibility whale flow',
          `copyScore ${Math.round((credibility.copyWorthyWalletScore || whale.score) * 100)}%`,
          `accum ${Math.round((credibility.whaleAccumulation || 0) * 100)}%`,
          whale.reasons.join('; ') || whale.source,
          `vol ${metrics.volumeRatio ? metrics.volumeRatio.toFixed(2) : 'n/a'}x`,
          `regime ${marketRegime ? marketRegime.regime : 'unknown'}`,
          source
        ].join(', ');

        const result = await this.portfolio.openPosition({
          strategyKey: this.strategyKey,
          symbol,
          metrics,
          sentiment: symbolSentiment,
          confidence,
          reason,
          marketRegime
        });
        if (!result.executed) continue;

        openPositions.push(result.position);
        signals.push({ symbol, metrics, confidence, reason });
        await this.alerts.sendSignalAlert({
          strategyKey: this.strategyKey,
          symbol,
          metrics,
          confidence,
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
        this.logger.error('WhaleShadow failed to evaluate entry', { symbol, error });
      }
    }

    return signals;
  }
}

module.exports = WhaleShadowAgent;
