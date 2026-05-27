'use strict';

const { clamp } = require('../utils/format');

const DEFAULTS = {
  wavehunter: {
    maxOpenPositions: 1,
    maxTradeFraction: 0.22,
    buyCooldownMinutes: 45,
    globalTradeCooldownMinutes: 8,
    symbolTradeCooldownMinutes: 30,
    minWaveScore: 0.55,
    staleSignalMaxAgeMinutes: 15,
    aggressiveness: 0.5,
    useTraditionalStopLoss: false,
    minHoldMinutes: 60
  },
  momentumpulse: {
    maxOpenPositions: 2,
    maxTradeFraction: 0.18,
    buyCooldownMinutes: 25,
    globalTradeCooldownMinutes: 6,
    symbolTradeCooldownMinutes: 20,
    staleSignalMaxAgeMinutes: 5,
    requireBreakout: true,
    requireEmaTrend: true,
    requireHigherTimeframeTrend: true,
    aggressiveness: 0.65,
    minHoldMinutes: 20
  },
  whaleshadow: {
    maxOpenPositions: 1,
    maxTradeFraction: 0.2,
    buyCooldownMinutes: 35,
    globalTradeCooldownMinutes: 7,
    symbolTradeCooldownMinutes: 25,
    minWhaleScore: 0.62,
    staleSignalMaxAgeMinutes: 10,
    aggressiveness: 0.55,
    minHoldMinutes: 30
  },
  sentinelmind: {
    maxOpenPositions: 1,
    maxTradeFraction: 0.18,
    buyCooldownMinutes: 30,
    globalTradeCooldownMinutes: 7,
    symbolTradeCooldownMinutes: 25,
    minSentimentEdge: 0.62,
    minSentimentConfidence: 0.35,
    staleSignalMaxAgeMinutes: 8,
    aggressiveness: 0.6,
    minHoldMinutes: 25
  },
  degensniper: {
    maxOpenPositions: 1,
    buyCooldownMinutes: 12,
    globalTradeCooldownMinutes: 3,
    symbolTradeCooldownMinutes: 8,
    staleSignalMaxAgeMinutes: 2,
    requireBreakout: false,
    requireEmaTrend: false,
    requireHigherTimeframeTrend: false,
    aggressiveness: 0.9,
    minHoldMinutes: 0
  }
};

function getStrategyRisk(strategyKey, globalRisk = {}) {
  const base = DEFAULTS[strategyKey] || {};
  const perStrategy = (globalRisk.strategies && globalRisk.strategies[strategyKey]) || {};
  return {
    ...globalRisk,
    ...base,
    ...perStrategy,
    strategyKey
  };
}

function regimeMultiplier(marketRegime, strategyRisk) {
  if (!marketRegime) return Number(strategyRisk.aggressiveness || 0.55);
  const base = Number(strategyRisk.aggressiveness || 0.55);
  const regime = marketRegime.regime;
  const modifiers = {
    trending: 0.12,
    sideways: -0.1,
    panic: -0.25,
    euphoria: -0.08,
    low_liquidity: -0.3,
    whale_manipulation: -0.2,
    high_volatility_chaos: -0.22
  };
  return clamp(base + (modifiers[regime] || 0), 0.15, 1);
}

module.exports = {
  DEFAULTS,
  getStrategyRisk,
  regimeMultiplier
};
