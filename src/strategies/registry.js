'use strict';

const STRATEGIES = [
  {
    key: 'wavehunter',
    name: 'WaveHunter',
    description: 'Cyclical wave mean-reversion with structural downtrend rejection',
    allocationPct: 0.25
  },
  {
    key: 'momentumpulse',
    name: 'MomentumPulse',
    description: 'Trend + breakout continuation with fake-breakout filtering',
    allocationPct: 0.25
  },
  {
    key: 'whaleshadow',
    name: 'WhaleShadow',
    description: 'Imitate statistically profitable whale-like flow',
    allocationPct: 0.25
  },
  {
    key: 'sentinelmind',
    name: 'SentinelMind',
    description: 'News + sentiment intelligence with source credibility scoring',
    allocationPct: 0.25
  }
];

function getStrategy(key) {
  return STRATEGIES.find((item) => item.key === key) || null;
}

module.exports = {
  STRATEGIES,
  getStrategy
};

