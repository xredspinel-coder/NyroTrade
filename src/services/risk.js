'use strict';

const { clamp, percent, toMillis } = require('../utils/format');
const { getStrategyRisk, regimeMultiplier } = require('../strategies/strategyConfig');

function isStaleMetrics(metrics, maxAgeMinutes) {
  if (!metrics || !metrics.analyzedAt) return true;
  const analyzedMs = Date.parse(metrics.analyzedAt);
  if (!Number.isFinite(analyzedMs)) return true;
  return Date.now() - analyzedMs > maxAgeMinutes * 60 * 1000;
}

function freshnessScore(metrics, maxAgeMinutes) {
  if (!metrics || !metrics.analyzedAt) return 0;
  const analyzedMs = Date.parse(metrics.analyzedAt);
  if (!Number.isFinite(analyzedMs)) return 0;
  const ageMs = Math.max(0, Date.now() - analyzedMs);
  const maxMs = Math.max(1, maxAgeMinutes) * 60 * 1000;
  // 1.0 at fresh, decays smoothly; never hard-zero unless extremely old/missing.
  const ratio = ageMs / maxMs;
  if (ratio <= 0) return 1;
  if (ratio >= 3) return 0.05;
  return clamp(1 - (ratio ** 1.25) * 0.85, 0.05, 1);
}

function effectiveAtrPercent(metrics, floor = 0.0015) {
  const raw = Number(metrics && metrics.atrPercent);
  if (!Number.isFinite(raw) || raw <= 0) return floor;
  return Math.max(raw, floor);
}

class RiskService {
  constructor({ storage, blacklist, config }) {
    this.storage = storage;
    this.blacklist = blacklist;
    this.config = config;
  }

  getStrategyConfig(strategyKey) {
    return getStrategyRisk(strategyKey, this.config.risk);
  }

  async canBuy({
    strategyKey,
    symbol,
    market,
    metrics,
    sentiment,
    openPositions,
    existingPosition,
    settings,
    snapshot,
    marketRegime,
    diagnostics,
    extraChecks = null
  }) {
    const strategyRisk = this.getStrategyConfig(strategyKey);
    const reasons = [];
    const prefix = strategyKey ? `${strategyKey}:` : '';
    const maxPositions = strategyRisk.maxOpenPositions || this.config.risk.maxOpenPositions;

    if (settings && settings.paused) reasons.push('bot paused');
    const blacklistReason = this.blacklist.getReason(symbol, market);
    if (blacklistReason) reasons.push(`blacklisted: ${blacklistReason}`);
    if (existingPosition && existingPosition.status === 'open') reasons.push('duplicate open position');
    if ((openPositions || []).length >= maxPositions) reasons.push('max open positions reached');
    if (await this.storage.isCooldownActive(`${prefix}buy:${symbol}`)) reasons.push('buy cooldown active');
    if (await this.storage.isCooldownActive(`${prefix}global:trade`)) reasons.push('global trade cooldown active');
    if (await this.storage.isCooldownActive(`${prefix}trade:${symbol}`)) reasons.push('symbol trade cooldown active');

    if (!metrics || !metrics.price) reasons.push('missing market metrics');
    if (metrics && metrics.quoteVolume < this.config.scanner.minQuoteVolumeUsdt) reasons.push('liquidity below minimum');
    if (metrics && metrics.liquidityScore < this.config.scanner.minLiquidityScore) reasons.push('liquidity score below minimum');
    const maxSpread = Number(strategyRisk.maxSpread || this.config.scanner.maxSpread);
    if (metrics && metrics.spread !== null && metrics.spread > maxSpread) reasons.push('spread too wide');
    const maxAge = Number(strategyRisk.staleSignalMaxAgeMinutes || this.config.risk.staleSignalMaxAgeMinutes);
    const fresh = freshnessScore(metrics, maxAge);
    if (fresh <= 0.15) reasons.push('signal too stale');

    if (strategyKey === 'momentumpulse' || !strategyKey) {
      if (metrics && metrics.priceChange < this.config.risk.minBuyPriceChange) {
        reasons.push(`momentum too weak (${percent(metrics.priceChange, 3)})`);
      }
      if (metrics && metrics.recentMomentum <= 0) reasons.push('short-term momentum not positive');
      const minVr = Number(strategyRisk.minVolumeRatio || this.config.risk.minVolumeRatio);
      const vc = Number(metrics && metrics.volumeConfidence);
      const volumeConfidence = Number.isFinite(vc) ? vc : clamp((Number(metrics.volumeRatio || 1) - 1) / Math.max(0.25, (minVr - 1)), 0, 1);
      if (metrics && metrics.volumeDataOk === false && metrics.quoteVolume < this.config.scanner.minQuoteVolumeUsdt * 1.15) {
        reasons.push('weak volume data quality');
      }
      if (metrics && (metrics.volumeRatio < minVr) && volumeConfidence < 0.45) {
        reasons.push('volume confidence too weak');
      }
      if (metrics && metrics.volatilityScore < this.config.scanner.minVolatilityScore) reasons.push('volatility score too low');
      if (metrics && metrics.volatilityScore >= this.config.risk.maxExtremeVolatilityScore) reasons.push('extreme volatility safeguard');
      if (metrics && Math.max(metrics.dailyChange, metrics.priceChange) * 100 > this.config.risk.maxPumpAlreadyMovedPercent) {
        reasons.push('move already extended');
      }
      if (metrics && metrics.abnormalPump) reasons.push('abnormal pump rejected');
      if (metrics && metrics.oneCandlePump) reasons.push('one-candle pump rejected');
      if (metrics && metrics.fakeBreakoutRisk) reasons.push('fake breakout risk');
      if (metrics && strategyRisk.requireBreakout !== false && !metrics.breakoutConfirmed) reasons.push('breakout not confirmed');
      if (metrics && metrics.bullishConfirmationCandles < this.config.risk.minBullishConfirmationCandles) {
        reasons.push('not enough bullish confirmation candles');
      }
      if (metrics && metrics.momentumPersistence < this.config.risk.minMomentumPersistence) {
        reasons.push('momentum persistence too weak');
      }
      const requireEma = strategyRisk.requireEmaTrend !== false && this.config.risk.requireEmaTrend;
      const requireHtf = strategyRisk.requireHigherTimeframeTrend !== false && this.config.risk.requireHigherTimeframeTrend;
      if (metrics && requireEma && !metrics.emaTrendOk) reasons.push('EMA trend filter failed');
      if (metrics && requireHtf && !metrics.higherTimeframeTrendOk) reasons.push('higher timeframe trend filter failed');
    }

    if (marketRegime) {
      const blocked = ['high_volatility_chaos', 'low_liquidity', 'panic', 'whale_manipulation'];
      if (blocked.includes(marketRegime.regime)) {
        reasons.push(`market regime risk: ${marketRegime.regime}`);
      }
      if (marketRegime.regime === 'sideways' && strategyKey === 'momentumpulse') {
        reasons.push('sideways market: momentum disabled');
      }
    }

    const healthScore = diagnostics && Number(diagnostics.strategyHealthScore);
    if (Number.isFinite(healthScore) && healthScore < this.config.risk.minStrategyHealthScore) {
      reasons.push('strategy health below minimum');
    }

    const category = this.getCategory(symbol, metrics);
    if (snapshot && snapshot.equity > 0) {
      const exposurePct = snapshot.exposurePct || {};
      const maxFraction = strategyRisk.maxTradeFraction || this.config.risk.maxTradeFraction;
      const projectedPct = ((snapshot.exposure && snapshot.exposure[category]) || 0) / snapshot.equity + maxFraction;
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

    if (strategyKey === 'sentinelmind' || strategyKey === 'momentumpulse') {
      if (sentiment && sentiment.label === 'bearish') reasons.push('bearish sentiment');
      if (sentiment && sentiment.confidence < (strategyRisk.minSentimentConfidence || this.config.sentiment.minSentimentConfidence)) {
        reasons.push('sentiment confidence too low');
      }
    }

    if (typeof extraChecks === 'function') {
      const extra = extraChecks({ metrics, sentiment, marketRegime, strategyRisk });
      if (extra && extra.length) reasons.push(...extra);
    }

    const confidence = this.signalConfidence(metrics, sentiment, strategyKey, marketRegime) * fresh;
    return {
      allowed: reasons.length === 0,
      reasons,
      confidence
    };
  }

  getSellReason({ position, metrics, sentiment, strategyKey }) {
    if (!position || !metrics || !metrics.price) {
      return { shouldSell: false, reason: 'missing data', pnlPct: 0 };
    }

    const strategyRisk = this.getStrategyConfig(strategyKey || position.strategyKey);
    const pnlPct = position.entryPrice > 0 ? (metrics.price - position.entryPrice) / position.entryPrice : 0;
    const openedMs = toMillis(position.openedAt);
    const minHoldMs = (strategyRisk.minHoldMinutes || 0) * 60 * 1000;
    const heldLongEnough = !openedMs || Date.now() - openedMs >= minHoldMs;

    const highestPrice = Math.max(Number(position.highestPrice || position.entryPrice || 0), Number(metrics.price || 0));
    const atrPct = effectiveAtrPercent(metrics);
    const trailDistance = Math.max(
      this.config.risk.trailingStopPercent,
      atrPct * this.config.risk.volatilityExitAtrMultiplier
    );
    const trailingStopPrice = pnlPct >= this.config.risk.trailingStopActivationPct
      ? highestPrice * (1 - trailDistance)
      : (position.trailingStopPrice || null);
    const bearishConfirmed = metrics.bearishConfirmationCandles >= this.config.risk.exitConfirmationCandles;
    const stopLossBuffer = Math.min(0.025, atrPct * 0.5);

    // Strategy-specific adaptive stop logic (replaces fixed STOP_LOSS trigger).
    // No fixed TP sell: takeProfit is used only as a "profit mode" threshold for trailing behavior.
    const baseStop = Number(this.config.risk.stopLoss);
    const atrStop = strategyKey === 'momentumpulse'
      ? -(atrPct * 2.2)
      : strategyKey === 'whaleshadow'
        ? -(atrPct * 2.8)
        : strategyKey === 'sentinelmind'
          ? -(atrPct * 2.6)
          : -(atrPct * 3.2);
    const dynamicStop = Math.min(baseStop, atrStop) - stopLossBuffer;

    if (strategyKey === 'wavehunter') {
      // WaveHunter: tolerate drawdown; exit only on danger-zone + structural weakness.
      const danger = -(Math.max(0.18, atrPct * 6.0));
      const structureWeak = !metrics.higherTimeframeTrendOk && metrics.recentMomentum < -0.002;
      if (pnlPct <= danger && structureWeak && bearishConfirmed) {
        return { shouldSell: true, reason: 'wave danger zone: structure weakness', pnlPct };
      }
    } else if (pnlPct <= dynamicStop) {
      return { shouldSell: true, reason: 'adaptive stop hit', pnlPct };
    }

    // Profit management: no fixed take-profit sell.
    // Trailing is active based on pnl threshold + weakening conditions.
    const profitMode = pnlPct >= Number(this.config.risk.takeProfit) * 0.6;
    const volumeCollapse = Number(metrics.volumeRatio || 1) < 0.9 && Number(metrics.volumeConfidence || 0.5) < 0.35;
    const rejection = metrics.fakeBreakoutRisk || (metrics.upperWickRatio > 0.6 && metrics.breakoutConfirmed);
    const momentumWeakening = Number(metrics.momentumDecay || 0) > 0.002 || (metrics.acceleration < 0 && metrics.recentMomentum < 0.001);

    if (profitMode && trailingStopPrice && metrics.price <= trailingStopPrice && bearishConfirmed) {
      return { shouldSell: true, reason: 'trailing exit confirmed', pnlPct };
    }
    if (profitMode && (volumeCollapse || rejection) && momentumWeakening && bearishConfirmed) {
      return { shouldSell: true, reason: 'exhaustion + momentum weakening', pnlPct };
    }

    if (!heldLongEnough) {
      return {
        shouldSell: false,
        reason: 'minimum hold period',
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

  signalConfidence(metrics, sentiment, strategyKey, marketRegime) {
    if (!metrics) return 0;
    const sentimentBoost = sentiment
      ? (sentiment.label === 'bullish' ? 0.1 : sentiment.label === 'neutral' ? 0.03 : -0.18)
      : 0;
    const volumeComponent = Number.isFinite(Number(metrics.volumeConfidence))
      ? Number(metrics.volumeConfidence)
      : clamp((metrics.volumeRatio - 1) / 2.5, 0, 1);
    const regime = regimeMultiplier(marketRegime, this.getStrategyConfig(strategyKey));

    const base = clamp(
      (metrics.volatilityScore * 0.22)
        + (metrics.momentumScore * 0.26)
        + (volumeComponent * 0.16)
        + (metrics.liquidityScore * 0.16)
        + (metrics.memeScore * 0.04)
        + (metrics.breakoutConfirmed ? 0.07 : 0)
        + (metrics.emaTrendOk ? 0.05 : 0)
        + (metrics.higherTimeframeTrendOk ? 0.04 : 0)
        + sentimentBoost,
      0,
      1
    );

    return clamp(base * regime, 0, 1);
  }

  getCategory(symbol, metrics = {}) {
    if (Number(metrics.memeScore || 0) >= 0.7) return 'meme';
    if (Number(metrics.volatilityScore || 0) >= 0.65) return 'volatile';
    if (/^(BTC|ETH|BNB|SOL)\//.test(String(symbol || '').toUpperCase())) return 'core';
    return 'other';
  }
}

module.exports = RiskService;
