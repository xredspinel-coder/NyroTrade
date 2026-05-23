'use strict';

const { money, percent, round } = require('../utils/format');

class AlertService {
  constructor({ storage, config, logger }) {
    this.storage = storage;
    this.config = config;
    this.logger = logger;
    this.telegram = null;
  }

  setTelegram(telegram) {
    this.telegram = telegram;
  }

  async sendSignalAlert({ symbol, metrics, confidence, stopLossPrice, takeProfitPrice, reason }) {
    const key = `alert:signal:${symbol}`;
    if (await this.storage.isCooldownActive(key)) return false;

    const text = [
      'NyroTrade paper BUY signal',
      `Symbol: ${symbol}`,
      `Momentum: ${percent(metrics.priceChange)}`,
      `Volume ratio: ${round(metrics.volumeRatio, 2)}x`,
      `Volatility score: ${round(metrics.volatilityScore, 3)}`,
      `Signal confidence: ${percent(confidence)}`,
      `Stop loss: ${round(stopLossPrice, 8)}`,
      `Take profit: ${round(takeProfitPrice, 8)}`,
      `Reason: ${reason}`
    ].join('\n');

    await this.deliver(text);
    await this.storage.saveAlert({
      type: 'signal',
      symbol,
      confidence,
      reason,
      metrics
    });
    await this.storage.setCooldown(
      key,
      this.config.risk.alertCooldownMinutes * 60 * 1000,
      { symbol, type: 'signal' }
    );
    this.logger.signal('Sent signal alert', { symbol, confidence, reason });
    return true;
  }

  async sendTradeAlert({ side, symbol, price, quantity, notional, pnl, pnlPct, reason }) {
    const base = this.config.exchange.baseSymbol;
    const lines = [
      `NyroTrade paper ${side}`,
      `Symbol: ${symbol}`,
      `Price: ${round(price, 8)}`,
      `Quantity: ${round(quantity, 8)}`,
      `Notional: ${money(notional, base)}`,
      `Reason: ${reason}`
    ];

    if (pnl !== undefined) {
      lines.push(`PnL: ${money(pnl, base)} (${percent(pnlPct || 0)})`);
    }

    await this.deliver(lines.join('\n'));
    await this.storage.saveAlert({
      type: 'trade',
      side,
      symbol,
      price,
      quantity,
      notional,
      pnl,
      pnlPct,
      reason
    });
  }

  async sendSystem(message, meta = {}) {
    const key = `alert:system:${message}`;
    if (await this.storage.isCooldownActive(key)) return false;
    await this.deliver(`NyroTrade system\n${message}`);
    await this.storage.saveAlert({
      type: 'system',
      message,
      meta
    });
    await this.storage.setCooldown(
      key,
      this.config.risk.alertCooldownMinutes * 60 * 1000,
      { type: 'system' }
    );
    return true;
  }

  async deliver(text) {
    if (!this.telegram) {
      this.logger.warn('Telegram service is not ready; alert stored only');
      return false;
    }
    await this.telegram.sendMessage(text);
    return true;
  }
}

module.exports = AlertService;
