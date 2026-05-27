'use strict';

const { clamp } = require('../utils/format');

/**
 * WhaleShadow intelligence layer.
 * Uses exchange flow proxies until external whale APIs are configured.
 */
class WhaleIntelService {
  constructor({ config, logger, storage }) {
    this.config = config;
    this.logger = logger;
    this.storage = storage;
    this.cache = new Map();
  }

  async getHistoricalProfitability(symbol) {
    if (!this.storage || !this.config.whale.trackingEnabled) {
      return {
        walletHistoricalProfitability: 0.5,
        repeatedSuccessfulEntries: 0,
        repeatedFailedEntries: 0,
        observedEntries: 0
      };
    }

    try {
      const positions = await this.storage.getClosedPositions(250, 'whaleshadow');
      const matching = positions.filter((position) => String(position.symbol || '').toUpperCase() === String(symbol || '').toUpperCase());
      const wins = matching.filter((position) => Number(position.realizedPnl || 0) > 0).length;
      const losses = matching.filter((position) => Number(position.realizedPnl || 0) < 0).length;
      const totalPnl = matching.reduce((sum, position) => sum + Number(position.realizedPnl || 0), 0);
      const winRate = matching.length > 0 ? wins / matching.length : 0.5;
      const pnlBias = clamp(totalPnl / Math.max(1, matching.length * 4), -0.25, 0.25);
      return {
        walletHistoricalProfitability: clamp(winRate + pnlBias, 0, 1),
        repeatedSuccessfulEntries: wins,
        repeatedFailedEntries: losses,
        observedEntries: matching.length
      };
    } catch (error) {
      this.logger.warn('Whale credibility history unavailable', { symbol, error });
      return {
        walletHistoricalProfitability: 0.5,
        repeatedSuccessfulEntries: 0,
        repeatedFailedEntries: 0,
        observedEntries: 0
      };
    }
  }

  scoreFromMetrics(metrics, history) {
    if (!metrics) return { score: 0, credible: false, reasons: ['no metrics'] };

    const volume = clamp((Number(metrics.volumeRatio || 0) - 1) / 3.5, 0, 1);
    const liquidity = clamp(Number(metrics.liquidityScore || 0), 0, 1);
    const rank = clamp(Number(metrics.rankScore || 0), 0, 1);
    const spreadPenalty = metrics.spread === null ? 0 : clamp(Number(metrics.spread || 0) / 0.004, 0, 1);
    const pumpPenalty = (metrics.oneCandlePump || metrics.abnormalPump || metrics.fakeBreakoutRisk) ? 0.4 : 0;
    const lowLiquidityPenalty = liquidity < 0.55 ? 0.25 : 0;
    const volumeConsistency = clamp(Number(metrics.volumeConsistency || 0), 0, 1);
    const upperWick = clamp(Number(metrics.upperWickRatio || 0), 0, 1);
    const positiveMomentum = clamp(Number(metrics.recentMomentum || 0) / 0.06, 0, 1);
    const negativeMomentum = clamp(-Number(metrics.recentMomentum || 0) / 0.04, 0, 1);
    const accumulation = clamp(
      volume * 0.34
        + liquidity * 0.22
        + positiveMomentum * 0.18
        + volumeConsistency * 0.14
        + (upperWick < 0.45 ? 0.12 : 0),
      0,
      1
    );
    const distribution = clamp(
      volume * 0.26
        + upperWick * 0.24
        + negativeMomentum * 0.2
        + clamp(-Number(metrics.acceleration || 0) / 0.02, 0, 1) * 0.18
        + (metrics.fakeBreakoutRisk ? 0.12 : 0),
      0,
      1
    );
    const exchangeWalletDetection = this.config.whale.exchangeWalletFilter
      ? clamp((volumeConsistency * 0.35) + (liquidity * 0.3) + (volume * 0.2) - (positiveMomentum * 0.25), 0, 1)
      : 0;
    const marketMakerFiltering = this.config.whale.marketMakerFilter
      ? clamp((volumeConsistency * 0.38) + (spreadPenalty < 0.25 ? 0.22 : 0) + (positiveMomentum < 0.18 ? 0.22 : 0) + (rank < 0.35 ? 0.1 : 0), 0, 1)
      : 0;
    const walletClustering = clamp(
      volumeConsistency * 0.34
        + clamp(Number(metrics.lastVolumeSpike || 0) / 4, 0, 1) * 0.22
        + clamp(Number(history.repeatedSuccessfulEntries || 0) / 4, 0, 1) * 0.24
        + liquidity * 0.2,
      0,
      1
    );
    const repeatedSuccess = clamp(Number(history.repeatedSuccessfulEntries || 0) / 4, 0, 1);
    const repeatedFailure = clamp(Number(history.repeatedFailedEntries || 0) / 4, 0, 1);
    const walletHistoricalProfitability = clamp(Number(history.walletHistoricalProfitability || 0.5), 0, 1);
    const copyWorthyWalletScore = clamp(
      walletHistoricalProfitability * 0.18
        + repeatedSuccess * 0.12
        + accumulation * 0.23
        + walletClustering * 0.14
        + liquidity * 0.13
        + rank * 0.1
        + volume * 0.1
        - repeatedFailure * 0.12
        - exchangeWalletDetection * 0.12
        - marketMakerFiltering * 0.1
        - distribution * 0.16
        - pumpPenalty
        - lowLiquidityPenalty,
      0,
      1
    );

    const score = copyWorthyWalletScore;
    const minScore = Number(this.config.whale.credibilityMinScore);
    const threshold = Number.isFinite(minScore) ? minScore : 0.55;

    const reasons = [];
    if (volume >= 0.5) reasons.push('volume surge');
    if (liquidity >= 0.6) reasons.push('liquidity ok');
    if (accumulation > distribution) reasons.push('accumulation dominant');
    if (walletHistoricalProfitability > 0.58) reasons.push('historically profitable cluster');
    if (repeatedSuccess > repeatedFailure) reasons.push('repeated successful entries');
    if (exchangeWalletDetection >= 0.65) reasons.push('exchange-wallet-like flow filtered');
    if (marketMakerFiltering >= 0.65) reasons.push('market-maker-like flow filtered');
    if (distribution >= 0.62) reasons.push('distribution risk');
    if (pumpPenalty > 0) reasons.push('suspicious pump filtered');
    if (spreadPenalty > 0.5) reasons.push('wide spread');

    return {
      score,
      credible: score >= threshold
        && pumpPenalty === 0
        && liquidity >= 0.5
        && accumulation > distribution
        && exchangeWalletDetection < 0.7
        && marketMakerFiltering < 0.7,
      reasons,
      source: 'exchange-flow-wallet-cluster-proxy',
      credibility: {
        walletHistoricalProfitability,
        repeatedSuccessfulEntries: Number(history.repeatedSuccessfulEntries || 0),
        repeatedFailedEntries: Number(history.repeatedFailedEntries || 0),
        exchangeWalletDetection,
        marketMakerFiltering,
        whaleAccumulation: accumulation,
        whaleDistribution: distribution,
        walletClustering,
        copyWorthyWalletScore
      }
    };
  }

  async getSignal(symbol, metrics) {
    const key = String(symbol || '').toUpperCase();
    const history = await this.getHistoricalProfitability(key);
    const result = this.scoreFromMetrics(metrics, history);
    this.cache.set(key, { ...result, updatedAt: Date.now() });
    return result;
  }

  getCached(symbol) {
    return this.cache.get(String(symbol || '').toUpperCase()) || null;
  }
}

module.exports = WhaleIntelService;
