'use strict';

const { clamp } = require('../../utils/format');

function sentimentEdge(sentiment) {
  if (!sentiment) return 0;
  const base = sentiment.label === 'bullish' ? 0.6 : sentiment.label === 'bearish' ? 0.1 : 0.4;
  const score = clamp((Number(sentiment.score || 0) + 1) / 2, 0, 1);
  const confidence = clamp(Number(sentiment.confidence || 0), 0, 1);
  return clamp(base * 0.45 + score * 0.35 + confidence * 0.2, 0, 1);
}

class SentinelMindAgent {
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
    this.strategyKey = 'sentinelmind';
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

        const baseDecision = this.risk.getSellReason({
          position,
          metrics,
          sentiment: symbolSentiment,
          strategyKey: this.strategyKey
        });
        const edge = sentimentEdge(symbolSentiment);
        const sentimentFlip = symbolSentiment && symbolSentiment.label === 'bearish' && edge < 0.25;
        const shouldSell = baseDecision.shouldSell || (sentimentFlip && Number(metrics.bearishConfirmationCandles || 0) >= 1);
        const reason = baseDecision.shouldSell ? baseDecision.reason : 'sentiment flipped bearish';

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
        this.logger.error('SentinelMind failed to manage open position', { symbol: position.symbol, error });
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
        const edge = sentimentEdge(symbolSentiment);

        if (edge < 0.62) continue;
        if (!metrics.emaTrendOk) continue;
        if (metrics.fakeBreakoutRisk) continue;
        if (marketRegime && marketRegime.regime === 'high_volatility_chaos') continue;
        if (symbolSentiment && symbolSentiment.confidence < this.config.sentiment.minSentimentConfidence) continue;

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

        const confidence = clamp(decision.confidence * 0.55 + edge * 0.45, 0, 1);
        const reason = [
          'sentiment edge',
          `${symbolSentiment.label} ${Math.round(edge * 100)}%`,
          `eng ${Math.round((symbolSentiment.confidence || 0) * 100)}%`,
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
        this.logger.error('SentinelMind failed to evaluate entry', { symbol, error });
      }
    }

    return signals;
  }
}

module.exports = SentinelMindAgent;

