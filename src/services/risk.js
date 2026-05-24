'use strict';

const { clamp, percent } = require('../utils/format');

class RiskService {
  constructor({ storage, blacklist, config }) {
    this.storage = storage;
    this.blacklist = blacklist;
    this.config = config;
  }

  async canBuy({ symbol, market, metrics, sentiment, openPositions, existingPosition, settings, snapshot, marketRegime, diagnostics }) {
    const reasons = [];

    if (settings && settings.paused) reasons.push('bot paused');
    const blacklistReason = this.blacklist.getReason(symbol, market);
    if (blacklistReason) reasons.push(`blacklisted: ${blacklistReason}`);
    if (existingPosition && existingPosition.status === 'open') reasons.push('duplicate open position');
    if ((openPositions || []).length >= this.config.risk.maxOpenPositions) reasons.push('max open positions reached');
    if (await this.storage.isCooldownActive(`buy:${symbol}`)) reasons.push('buy cooldown active');
    if (await this.storage.isCooldownActive('global:trade')) reasons.push('global trade cooldown active');
    if (await this.storage.isCooldownActive(`trade:${symbol}`)) reasons.push('symbol trade cooldown active');

    if (!metrics || !metrics.price) reasons.push('missing market metrics');
    if (metrics && metrics.quoteVolume < this.config.scanner.minQuoteVolumeUsdt) reasons.push('liquidity below minimum');
    if (metrics && metrics.liquidityScore < this.config.scanner.minLiquidityScore) reasons.push('liquidity score below minimum');
    if (metrics && metrics.spread !== null && metrics.spread > this.config.scanner.maxSpread) reasons.push('spread too wide');
    if (metrics && metrics.priceChange < this.config.risk.minBuyPriceChange) {
      reasons.push(`momentum too weak (${percent(metrics.priceChange)})`);
    }
    if (metrics && metrics.recentMomentum <= 0) reasons.push('short-term momentum not positive');
    if (metrics && metrics.volumeRatio < this.config.risk.minVolumeRatio) reasons.push('volume spike not confirmed');
    if (metrics && metrics.volatilityScore < this.config.scanner.minVolatilityScore) reasons.push('volatility score too low');
    if (metrics && metrics.volatilityScore >= this.config.risk.maxExtremeVolatilityScore) reasons.push('extreme volatility safeguard');
    if (metrics && Math.max(metrics.dailyChange, metrics.priceChange) * 100 > this.config.risk.maxPumpAlreadyMovedPercent) {
      reasons.push('move already extended');
    }
    if (metrics && metrics.abnormalPump) reasons.push('abnormal pump rejected');
    if (metrics && metrics.oneCandlePump) reasons.push('one-candle pump rejected');
    if (metrics && metrics.fakeBreakoutRisk) reasons.push('fake breakout risk');
    if (metrics && !metrics.breakoutConfirmed) reasons.push('breakout not confirmed');
    if (metrics && metrics.bullishConfirmationCandles < this.config.risk.minBullishConfirmationCandles) {
      reasons.push('not enough bullish confirmation candles');
    }
    if (metrics && metrics.momentumPersistence < this.config.risk.minMomentumPersistence) {
      reasons.push('momentum persistence too weak');
    }
    if (metrics && this.config.risk.requireEmaTrend && !metrics.emaTrendOk) reasons.push('EMA trend filter failed');
    if (metrics && this.config.risk.requireHigherTimeframeTrend && !metrics.higherTimeframeTrendOk) {
      reasons.push('higher timeframe trend filter failed');
    }
    if (metrics && Date.now() - Date.parse(metrics.analyzedAt || new Date().toISOString()) > this.config.risk.staleSignalMaxAgeMinutes * 60 * 1000) {
      reasons.push('stale signal');
    }
    if (marketRegime && ['high_volatility_chaos', 'low_liquidity'].includes(marketRegime.regime)) {
      reasons.push(`market regime risk: ${marketRegime.regime}`);
    }
    const healthScore = diagnostics && Number(diagnostics.strategyHealthScore);
    if (Number.isFinite(healthScore) && healthScore < this.config.risk.minStrategyHealthScore) {
      reasons.push('strategy health below minimum');
    }
    const category = this.getCategory(symbol, metrics);
    if (snapshot && snapshot.equity > 0) {
      const exposurePct = snapshot.exposurePct || {};
      const projectedPct = ((snapshot.exposure && snapshot.exposure[category]) || 0) / snapshot.equity
        + this.config.risk.maxTradeFraction;
      if (category === 'meme' && projectedPct > this.config.risk.maxMemeExposurePct) {
        reasons.push('meme exposure cap reached');
      }
      if (projectedPct > this.config.risk.maxCategoryExposurePct) {
        reasons.push(`${category} category exposure cap reached`);
      }
      if (category === 'meme' && Number(exposurePct.meme || 0) >= this.config.risk.maxMemeExposurePct) {
        reasons.push('meme exposure already at cap');
      }
    }
    if (sentiment && sentiment.label === 'bearish') reasons.push('bearish sentiment');
    if (sentiment && sentiment.confidence < this.config.sentiment.minSentimentConfidence) reasons.push('sentiment confidence too low');

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
    const highestPrice = Math.max(Number(position.highestPrice || position.entryPrice || 0), Number(metrics.price || 0));
    const trailDistance = Math.max(
      this.config.risk.trailingStopPercent,
      Number(metrics.atrPercent || 0) * this.config.risk.volatilityExitAtrMultiplier
    );
    const trailingStopPrice = pnlPct >= this.config.risk.trailingStopActivationPct
      ? highestPrice * (1 - trailDistance)
      : (position.trailingStopPrice || null);
    const bearishConfirmed = metrics.bearishConfirmationCandles >= this.config.risk.exitConfirmationCandles;
    const stopLossBuffer = Math.min(0.025, Number(metrics.atrPercent || 0) * 0.5);

    if (pnlPct <= this.config.risk.stopLoss - stopLossBuffer) {
      return { shouldSell: true, reason: 'stop loss hit', pnlPct };
    }
    if (pnlPct >= this.config.risk.takeProfit) {
      if (trailingStopPrice && metrics.price <= trailingStopPrice) {
        return { shouldSell: true, reason: 'volatility-adjusted trailing take profit', pnlPct };
      }
      return {
        shouldSell: false,
        reason: 'take profit reached; trailing stop active',
        pnlPct,
        positionPatch: { highestPrice, trailingStopPrice }
      };
    }
    if (trailingStopPrice && metrics.price <= trailingStopPrice && bearishConfirmed) {
      return { shouldSell: true, reason: 'trailing stop confirmed', pnlPct };
    }
    if (metrics.recentMomentum < -this.config.risk.minBuyPriceChange && metrics.acceleration < 0 && bearishConfirmed) {
      return { shouldSell: true, reason: 'confirmed momentum reversal', pnlPct };
    }
    if (sentiment && sentiment.label === 'bearish' && sentiment.score < -0.35 && bearishConfirmed) {
      return { shouldSell: true, reason: 'confirmed bearish sentiment', pnlPct };
    }
    if (metrics.rankScore < this.config.risk.sellVolatilityRankThreshold && metrics.momentumScore < 0.2 && bearishConfirmed) {
      return { shouldSell: true, reason: 'volatility rank collapse', pnlPct };
    }

    return {
      shouldSell: false,
      reason: 'hold',
      pnlPct,
      positionPatch: { highestPrice, trailingStopPrice }
    };
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
        + (metrics.breakoutConfirmed ? 0.08 : 0)
        + (metrics.emaTrendOk ? 0.06 : 0)
        + (metrics.higherTimeframeTrendOk ? 0.05 : 0)
        + 0.1
        + sentimentBoost,
      0,
      1
    );
  }

  getCategory(symbol, metrics = {}) {
    if (Number(metrics.memeScore || 0) >= 0.7) return 'meme';
    if (Number(metrics.volatilityScore || 0) >= 0.65) return 'volatile';
    if (/^(BTC|ETH|BNB|SOL)\//.test(String(symbol || '').toUpperCase())) return 'core';
    return 'other';
  }
}

module.exports = RiskService;
