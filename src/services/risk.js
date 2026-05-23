'use strict';

const { clamp, percent } = require('../utils/format');

class RiskService {
  constructor({ storage, blacklist, config }) {
    this.storage = storage;
    this.blacklist = blacklist;
    this.config = config;
  }

  async canBuy({ symbol, market, metrics, sentiment, openPositions, existingPosition, settings }) {
    const reasons = [];

    if (settings && settings.paused) reasons.push('bot paused');
    const blacklistReason = this.blacklist.getReason(symbol, market);
    if (blacklistReason) reasons.push(`blacklisted: ${blacklistReason}`);
    if (existingPosition && existingPosition.status === 'open') reasons.push('duplicate open position');
    if ((openPositions || []).length >= this.config.risk.maxOpenPositions) reasons.push('max open positions reached');
    if (await this.storage.isCooldownActive(`buy:${symbol}`)) reasons.push('buy cooldown active');

    if (!metrics || !metrics.price) reasons.push('missing market metrics');
    if (metrics && metrics.quoteVolume < this.config.scanner.minQuoteVolumeUsdt) reasons.push('liquidity below minimum');
    if (metrics && metrics.spread !== null && metrics.spread > this.config.scanner.maxSpread) reasons.push('spread too wide');
    if (metrics && metrics.priceChange < this.config.risk.minBuyPriceChange) {
      reasons.push(`momentum too weak (${percent(metrics.priceChange)})`);
    }
    if (metrics && metrics.recentMomentum <= 0) reasons.push('short-term momentum not positive');
    if (metrics && metrics.volumeRatio < this.config.risk.minVolumeRatio) reasons.push('volume spike not confirmed');
    if (metrics && metrics.volatilityScore < this.config.scanner.minVolatilityScore) reasons.push('volatility score too low');
    if (metrics && Math.max(metrics.dailyChange, metrics.priceChange) * 100 > this.config.risk.maxPumpAlreadyMovedPercent) {
      reasons.push('move already extended');
    }
    if (sentiment && sentiment.label === 'bearish') reasons.push('bearish sentiment');

    const confidence = this.signalConfidence(metrics, sentiment);
    return {
      allowed: reasons.length === 0,
      reasons,
      confidence
    };
  }

  getSellReason({ position, metrics, sentiment }) {
    if (!position || !metrics || !metrics.price) {
      return { shouldSell: false, reason: 'missing data', pnlPct: 0 };
    }

    const pnlPct = position.entryPrice > 0 ? (metrics.price - position.entryPrice) / position.entryPrice : 0;
    if (pnlPct <= this.config.risk.stopLoss) {
      return { shouldSell: true, reason: 'stop loss hit', pnlPct };
    }
    if (pnlPct >= this.config.risk.takeProfit) {
      return { shouldSell: true, reason: 'take profit hit', pnlPct };
    }
    if (metrics.recentMomentum < -this.config.risk.minBuyPriceChange && metrics.acceleration < 0) {
      return { shouldSell: true, reason: 'momentum reversal', pnlPct };
    }
    if (sentiment && sentiment.label === 'bearish' && sentiment.score < -0.2) {
      return { shouldSell: true, reason: 'bearish sentiment', pnlPct };
    }
    if (metrics.rankScore < this.config.risk.sellVolatilityRankThreshold && metrics.momentumScore < 0.25) {
      return { shouldSell: true, reason: 'volatility rank collapse', pnlPct };
    }

    return { shouldSell: false, reason: 'hold', pnlPct };
  }

  signalConfidence(metrics, sentiment) {
    if (!metrics) return 0;
    const sentimentBoost = sentiment
      ? (sentiment.label === 'bullish' ? 0.12 : sentiment.label === 'neutral' ? 0.04 : -0.2)
      : 0;
    return clamp(
      (metrics.volatilityScore * 0.24)
        + (metrics.momentumScore * 0.28)
        + (clamp((metrics.volumeRatio - 1) / 3, 0, 1) * 0.18)
        + (metrics.liquidityScore * 0.14)
        + (metrics.memeScore * 0.06)
        + 0.1
        + sentimentBoost,
      0,
      1
    );
  }
}

module.exports = RiskService;
