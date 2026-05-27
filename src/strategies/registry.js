'use strict';

const STRATEGIES = [
  {
    key: 'wavehunter',
    name: 'WaveHunter',
    description: 'Cyclical wave mean-reversion with structural downtrend rejection',
    allocationPct: 0.2
  },
  {
    key: 'momentumpulse',
    name: 'MomentumPulse',
    description: 'Trend + breakout continuation with fake-breakout filtering',
    allocationPct: 0.2
  },
  {
    key: 'whaleshadow',
    name: 'WhaleShadow',
    description: 'Imitate statistically profitable whale-like flow',
    allocationPct: 0.2
  },
  {
    key: 'sentinelmind',
    name: 'SentinelMind',
    description: 'News + sentiment intelligence with source credibility scoring',
    allocationPct: 0.2
  },
  {
    key: 'degensniper',
    name: 'DegenSniper',
    description: 'Aggressive short-term asymmetric upside hunter with opportunity scoring',
    allocationPct: 0.2
  }
];

function getStrategy(key) {
  return STRATEGIES.find((item) => item.key === key) || null;
}

function getStrategyKeys() {
  return STRATEGIES.map((item) => item.key);
}

function getStrategyName(key) {
  const strategy = getStrategy(key);
  return strategy ? strategy.name : String(key || 'legacy');
}

function getStrategyBudget(key, totalBalance) {
  const strategy = getStrategy(key);
  const balance = Number(totalBalance || 0);
  if (!strategy || balance <= 0) return 0;
  return balance * Number(strategy.allocationPct || (1 / STRATEGIES.length));
}

module.exports = {
  STRATEGIES,
  getStrategy,
  getStrategyBudget,
  getStrategyKeys,
  getStrategyName
};
