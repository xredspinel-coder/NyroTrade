'use strict';

const { clamp, percent, round, uniqueSymbols } = require('../../utils/format');

function sentimentComponent(sentiment, metrics) {
  if (!sentiment) {
    return {
      narrativeStrength: clamp(Number(metrics.memeScore || 0) * 0.35, 0, 1),
      socialVelocity: clamp(Number(metrics.memeScore || 0) * 0.25, 0, 1)
    };
  }

  const score = clamp((Number(sentiment.score || 0) + 1) / 2, 0, 1);
  const confidence = clamp(Number(sentiment.confidence || 0), 0, 1);
  const label = sentiment.label === 'bullish' ? 0.75 : sentiment.label === 'bearish' ? 0.1 : 0.45;
  const meme = clamp(Number(metrics.memeScore || 0), 0, 1);

  return {
    narrativeStrength: clamp(label * 0.34 + score * 0.32 + confidence * 0.24 + meme * 0.1, 0, 1),
    socialVelocity: clamp(confidence * 0.48 + score * 0.24 + meme * 0.18 + clamp(Number(metrics.volumeRatio || 1) / 4, 0, 1) * 0.1, 0, 1)
  };
}

function whaleScore(whale) {
  if (!whale) return 0;
  if (whale.credibility && Number.isFinite(Number(whale.credibility.copyWorthyWalletScore))) {
    return clamp(Number(whale.credibility.copyWorthyWalletScore), 0, 1);
  }
  return clamp(Number(whale.score || 0), 0, 1);
}

function continuationProbability(metrics) {
  return clamp(
    clamp(Number(metrics.momentumPersistence || 0), 0, 1) * 0.28
      + (metrics.breakoutConfirmed ? 0.18 : 0)
      + (metrics.emaTrendOk ? 0.14 : 0)
      + (metrics.higherTimeframeTrendOk ? 0.16 : 0)
      + clamp(Number(metrics.recentMomentum || 0) / 0.08, 0, 1) * 0.14
      + (metrics.fakeBreakoutRisk ? -0.2 : 0)
      + (metrics.oneCandlePump ? -0.18 : 0)
      + (Number(metrics.upperWickRatio || 0) > 0.62 ? -0.1 : 0),
    0,
    1
  );
}

function opportunityScore({ metrics, sentiment, whale, config }) {
  const sniper = config.degenSniper || {};
  const minAcceleration = Number(sniper.minMomentumAcceleration || 0.015);
  const minVolumeAcceleration = Number(sniper.minVolumeAcceleration || 2);
  const sentimentScores = sentimentComponent(sentiment, metrics);
  const acceleration = clamp(Number(metrics.acceleration || 0) / Math.max(minAcceleration * 2.5, 0.001), 0, 1);
  const volumeExpansion = clamp(
    ((Number(metrics.volumeRatio || 1) - 1) / Math.max(minVolumeAcceleration - 1, 0.25)) * 0.78
      + clamp(Number(metrics.lastVolumeSpike || 0) / 4, 0, 1) * 0.22,
    0,
    1
  );
  const liquidity = clamp(Number(metrics.liquidityScore || 0), 0, 1);
  const whaleActivity = whaleScore(whale);
  const volatilityExpansion = clamp(Number(metrics.volatilityScore || 0) * 0.72 + clamp(Number(metrics.atrPercent || 0) / 0.08, 0, 1) * 0.28, 0, 1);
  const continuation = continuationProbability(metrics);

  const score = clamp(
    acceleration * 0.18
      + volumeExpansion * 0.17
      + liquidity * 0.12
      + sentimentScores.narrativeStrength * 0.12
      + whaleActivity * 0.12
      + sentimentScores.socialVelocity * 0.1
      + volatilityExpansion * 0.09
      + continuation * 0.1,
    0,
    1
  );

  return {
    score,
    components: {
      acceleration,
      volumeExpansion,
      liquidity,
      narrativeStrength: sentimentScores.narrativeStrength,
      whaleActivity,
      socialVelocity: sentimentScores.socialVelocity,
      volatilityExpansion,
      continuationProbability: continuation
    }
  };
}

function rugOrDyingRisk(metrics, maxSpread) {
  const spreadTooWide = metrics.spread !== null && Number(metrics.spread || 0) > maxSpread;
  const distributionWick = Number(metrics.upperWickRatio || 0) > 0.68 && Number(metrics.lastVolumeSpike || 0) >= 1.6;
  const dyingMomentum = Number(metrics.recentMomentum || 0) <= 0 && Number(metrics.acceleration || 0) < 0;
  const liquidityTrap = Number(metrics.liquidityScore || 0) < 0.45 || spreadTooWide;
  const obviousPump = metrics.oneCandlePump || (metrics.abnormalPump && Number(metrics.momentumPersistence || 0) < 0.7);

  return {
    risky: Boolean(distributionWick || dyingMomentum || liquidityTrap || obviousPump || metrics.fakeBreakoutRisk),
    reasons: [
      distributionWick ? 'distribution wick' : null,
      dyingMomentum ? 'dying momentum' : null,
      liquidityTrap ? 'liquidity/spread trap' : null,
      obviousPump ? 'late obvious pump' : null,
      metrics.fakeBreakoutRisk ? 'fake breakout risk' : null
    ].filter(Boolean)
  };
}

class DegenSniperAgent {
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
    this.strategyKey = 'degensniper';
  }

  async tick({ source = 'scheduler' } = {}) {
    await this.manageOpenPositions();
    if (!this.config.degenSniper.enabled) return { disabled: true, signals: [] };
    const settings = await this.storage.getStrategySettings(this.strategyKey);
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
        const whale = await this.whaleIntel.getSignal(position.symbol, metrics);
        const opportunity = opportunityScore({ metrics, sentiment: symbolSentiment, whale, config: this.config });
        const pnlPct = position.entryPrice > 0 ? (Number(metrics.price || 0) - position.entryPrice) / position.entryPrice : 0;
        const highestPrice = Math.max(Number(position.highestPrice || position.entryPrice || 0), Number(metrics.price || 0));
        const trailDistance = Math.max(Number(this.config.degenSniper.trailingStop || 0.06), Number(metrics.atrPercent || 0.0015) * 2.2);
        const trailingStopPrice = pnlPct > 0 ? highestPrice * (1 - trailDistance) : (position.trailingStopPrice || null);
        const entryAtr = Number(position.metrics && position.metrics.atrPercent) || Number(metrics.atrPercent || 0);

        const emergencyReversal = Number(metrics.singleCandleMove || 0) <= -Math.max(0.035, Number(metrics.atrPercent || 0.0015) * 2.5)
          && Number(metrics.lastVolumeSpike || 0) >= 1.2;
        const momentumDecay = Number(metrics.momentumDecay || 0) > 0.003
          || (Number(metrics.acceleration || 0) < -0.004 && Number(metrics.recentMomentum || 0) < 0.003);
        const volumeCollapse = Number(metrics.volumeRatio || 1) < 0.78 && Number(metrics.volumeConfidence || 0.5) < 0.36;
        const whaleExit = whale
          && whale.credibility
          && Number(whale.credibility.whaleDistribution || 0) > 0.62
          && Number(whale.credibility.whaleAccumulation || 0) < 0.38;
        const volatilityCollapse = entryAtr > 0
          && Number(metrics.atrPercent || 0) < entryAtr * 0.55
          && Number(metrics.rollingStddev || 0) < Number((position.metrics && position.metrics.rollingStddev) || metrics.rollingStddev || 0) * 0.65;
        const trailingHit = trailingStopPrice && Number(metrics.price || 0) <= trailingStopPrice;
        const opportunityLost = pnlPct > 0 && opportunity.score < Number(this.config.degenSniper.minOpportunityScore || 0.78) * 0.62;

        const exitReason = emergencyReversal
          ? 'emergency exit: abnormal reversal'
          : trailingHit
            ? 'intelligent trailing exit'
            : whaleExit
              ? 'whale distribution detected'
              : momentumDecay && volumeCollapse
                ? 'momentum decay + volume collapse'
                : volatilityCollapse && momentumDecay
                  ? 'volatility collapse + momentum decay'
                  : opportunityLost
                    ? 'opportunity score collapsed'
                    : null;

        await this.portfolio.updatePositionRiskState(position.symbol, {
          highestPrice,
          trailingStopPrice,
          opportunityScore: opportunity.score,
          opportunityComponents: opportunity.components
        }, this.strategyKey);

        if (exitReason) {
          const result = await this.portfolio.closePosition({
            strategyKey: this.strategyKey,
            symbol: position.symbol,
            price: metrics.price,
            metrics: {
              ...metrics,
              opportunityScore: opportunity.score,
              opportunityComponents: opportunity.components,
              whale
            },
            sentiment: symbolSentiment,
            reason: exitReason
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
              reason: exitReason
            });
          }
          continue;
        }

        const partialEnabled = this.config.degenSniper.partialTakeProfit;
        const expansionProfit = pnlPct > Math.max(trailDistance * 0.85, Number(metrics.atrPercent || 0.0015) * 2.4);
        const expansionFading = Number(metrics.acceleration || 0) <= 0 || Number(metrics.volumeRatio || 1) < Number((position.metrics && position.metrics.volumeRatio) || 1) * 0.72;
        if (partialEnabled && !position.partialProfitTaken && expansionProfit && expansionFading) {
          const result = await this.portfolio.reducePosition({
            strategyKey: this.strategyKey,
            symbol: position.symbol,
            fraction: 0.5,
            price: metrics.price,
            metrics: {
              ...metrics,
              opportunityScore: opportunity.score,
              opportunityComponents: opportunity.components,
              whale
            },
            sentiment: symbolSentiment,
            reason: 'partial profit: expansion fading'
          });
          if (result.executed) {
            await this.alerts.sendTradeAlert({
              strategyKey: this.strategyKey,
              side: 'SELL',
              symbol: position.symbol,
              price: metrics.price,
              quantity: result.position.closedQuantity,
              notional: result.position.closedNotional,
              pnl: result.position.realizedPnl,
              pnlPct: result.position.realizedPnlPct,
              reason: 'partial profit: expansion fading'
            });
          }
        }
      } catch (error) {
        this.logger.error('DegenSniper failed to manage open position', { symbol: position.symbol, error });
      }
    }
  }

  async findEntries(settings, source) {
    const [watchlist, topVolatile, snapshot, marketRegime] = await Promise.all([
      this.scanner.getWatchlist(),
      this.scanner.getTopVolatile(25).catch(() => []),
      this.portfolio.getSnapshot({ strategyKey: this.strategyKey }),
      this.marketRegime.getCurrent().catch(() => null)
    ]);
    const openPositions = await this.storage.getOpenPositions(this.strategyKey);
    const openBySymbol = new Map(openPositions.map((position) => [position.symbol, position]));
    const candidates = uniqueSymbols([
      ...watchlist,
      ...topVolatile.map((item) => item.symbol)
    ]).slice(0, 35);
    const signals = [];

    await this.exchange.getTickers(candidates);

    for (const symbol of candidates) {
      try {
        if (openBySymbol.get(symbol)) continue;
        const market = this.exchange.cache.getMarket(symbol);
        const metrics = await this.analyzer.analyzeSymbol(symbol);
        const symbolSentiment = await this.sentiment.getSentiment(symbol);
        const whale = await this.whaleIntel.getSignal(symbol, metrics);
        const opportunity = opportunityScore({ metrics, sentiment: symbolSentiment, whale, config: this.config });
        const sniper = this.config.degenSniper;
        const maxSpread = Number(sniper.maxSpread || this.config.scanner.maxSpread);
        const rugRisk = rugOrDyingRisk(metrics, maxSpread);
        const socialOrWhale = opportunity.components.socialVelocity >= 0.58
          || opportunity.components.narrativeStrength >= 0.64
          || opportunity.components.whaleActivity >= 0.62;

        if (opportunity.score < Number(sniper.minOpportunityScore || 0.78)) continue;
        if (Number(metrics.acceleration || 0) < Number(sniper.minMomentumAcceleration || 0.015)) continue;
        if (Number(metrics.volumeRatio || 0) < Number(sniper.minVolumeAcceleration || 2)) continue;
        if (metrics.spread !== null && Number(metrics.spread || 0) > maxSpread) continue;
        if (rugRisk.risky) continue;
        if (!socialOrWhale && opportunity.score < Number(sniper.minOpportunityScore || 0.78) + 0.06) continue;

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
          diagnostics: null,
          extraChecks: () => {
            const reasons = [];
            if (rugRisk.risky) reasons.push(`rug/dying risk: ${rugRisk.reasons.join(', ')}`);
            if (!socialOrWhale && opportunity.score < Number(sniper.minOpportunityScore || 0.78) + 0.06) {
              reasons.push('missing social or whale confirmation');
            }
            return reasons;
          }
        });
        if (!decision.allowed) continue;

        const confidence = clamp(decision.confidence * 0.32 + opportunity.score * 0.68, 0, 1);
        const reason = [
          'DegenSniper opportunity',
          `score ${Math.round(opportunity.score * 100)}%`,
          `accel ${percent(metrics.acceleration, 2)}`,
          `vol ${round(metrics.volumeRatio, 2)}x`,
          `social ${Math.round(opportunity.components.socialVelocity * 100)}%`,
          `whale ${Math.round(opportunity.components.whaleActivity * 100)}%`,
          `regime ${marketRegime ? marketRegime.regime : 'unknown'}`,
          source
        ].join(', ');

        const result = await this.portfolio.openPosition({
          strategyKey: this.strategyKey,
          symbol,
          metrics: {
            ...metrics,
            opportunityScore: opportunity.score,
            opportunityComponents: opportunity.components,
            whale
          },
          sentiment: symbolSentiment,
          confidence,
          reason,
          marketRegime
        });
        if (!result.executed) continue;

        openPositions.push(result.position);
        signals.push({ symbol, metrics, confidence, reason, opportunity });

        await this.alerts.sendSignalAlert({
          strategyKey: this.strategyKey,
          symbol,
          metrics,
          confidence,
          stopLossPrice: null,
          takeProfitPrice: null,
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
        this.logger.error('DegenSniper failed to evaluate entry', { symbol, error });
      }
    }

    return signals;
  }
}

module.exports = DegenSniperAgent;
module.exports.opportunityScore = opportunityScore;
