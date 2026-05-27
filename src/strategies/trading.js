'use strict';

const WaveHunterAgent = require('./agents/waveHunter');
const MomentumPulseAgent = require('./agents/momentumPulse');
const WhaleShadowAgent = require('./agents/whaleShadow');
const SentinelMindAgent = require('./agents/sentinelMind');
const DegenSniperAgent = require('./agents/degenSniper');

class TradingStrategy {
  constructor(services) {
    this.services = services;
    this.logger = services.logger;
    this.storage = services.storage;
    this.running = false;
    this.agents = [
      new WaveHunterAgent(services),
      new MomentumPulseAgent(services),
      new WhaleShadowAgent(services),
      new SentinelMindAgent(services),
      new DegenSniperAgent(services)
    ];
  }

  async runOnce({ source = 'scheduler' } = {}) {
    if (this.running) {
      this.logger.warn('Strategy tick skipped because previous tick is still running', { source });
      return { skipped: true };
    }

    this.running = true;
    try {
      const globalSettings = await this.storage.getSettings();
      if (globalSettings.paused) return { paused: true, strategies: [] };

      const results = [];
      for (const agent of this.agents) {
        const result = await agent.tick({ source });
        results.push({ strategyKey: agent.strategyKey, ...result });
      }

      return { paused: false, strategies: results };
    } finally {
      this.running = false;
    }
  }
}

module.exports = TradingStrategy;
