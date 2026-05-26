'use strict';

const { clamp } = require('../utils/format');

/**
 * WhaleShadow intelligence layer.
 * Uses exchange flow proxies until external whale APIs are configured.
 */
class WhaleIntelService {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.cache = new Map();
  }

  scoreFromMetrics(metrics) {
    if (!metrics) return { score: 0, credible: false, reasons: ['no metrics'] };

    const volume = clamp((Number(metrics.volumeRatio || 0) - 1) / 3.5, 0, 1);
    const liquidity = clamp(Number(metrics.liquidityScore || 0), 0, 1);
    const rank = clamp(Number(metrics.rankScore || 0), 0, 1);
    const spreadPenalty = metrics.spread === null ? 0 : clamp(Number(metrics.spread || 0) / 0.004, 0, 1);
    const pumpPenalty = (metrics.oneCandlePump || metrics.abnormalPump || metrics.fakeBreakoutRisk) ? 0.4 : 0;
    const lowLiquidityPenalty = liquidity < 0.55 ? 0.25 : 0;

    const score = clamp(
      volume * 0.42 + liquidity * 0.28 + rank * 0.22 - spreadPenalty * 0.15 - pumpPenalty - lowLiquidityPenalty,
      0,
      1
    );

    const reasons = [];
    if (volume >= 0.5) reasons.push('volume surge');
    if (liquidity >= 0.6) reasons.push('liquidity ok');
    if (pumpPenalty > 0) reasons.push('suspicious pump filtered');
    if (spreadPenalty > 0.5) reasons.push('wide spread');

    return {
      score,
      credible: score >= 0.55 && pumpPenalty === 0 && liquidity >= 0.5,
      reasons,
      source: 'exchange-flow-proxy'
    };
  }

  async getSignal(symbol, metrics) {
    const key = String(symbol || '').toUpperCase();
    const result = this.scoreFromMetrics(metrics);
    this.cache.set(key, { ...result, updatedAt: Date.now() });
    return result;
  }

  getCached(symbol) {
    return this.cache.get(String(symbol || '').toUpperCase()) || null;
  }
}

module.exports = WhaleIntelService;
