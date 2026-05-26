'use strict';

const { clamp, safeNumber } = require('../../utils/format');
const { atr, average } = require('../metrics');

function close(c) { return safeNumber(c && c[4]); }
function high(c) { return safeNumber(c && c[2]); }
function low(c) { return safeNumber(c && c[3]); }

function percentile(values, p) {
  const filtered = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (filtered.length === 0) return 0;
  const idx = clamp(p, 0, 1) * (filtered.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return filtered[lo];
  const w = idx - lo;
  return filtered[lo] * (1 - w) + filtered[hi] * w;
}

function waveQualification(candles) {
  const closes = candles.map(close).filter((v) => v > 0);
  if (closes.length < 80) {
    return { eligible: false, waveScore: 0, reason: 'insufficient history' };
  }

  const last = closes[closes.length - 1];
  const p10 = percentile(closes.slice(-160), 0.10);
  const p50 = percentile(closes.slice(-160), 0.50);
  const p90 = percentile(closes.slice(-160), 0.90);
  const amplitude = p50 > 0 ? (p90 - p10) / p50 : 0;

  // Simple structural downtrend rejection: persistent lower highs on HTF.
  const highs = candles.map(high).filter((v) => v > 0);
  const recentHigh = Math.max(...highs.slice(-72));
  const priorHigh = Math.max(...highs.slice(-144, -72));
  const lowerHighs = priorHigh > 0 && recentHigh < priorHigh * 0.97;

  const lows = candles.map(low).filter((v) => v > 0);
  const recentLow = Math.min(...lows.slice(-72));
  const priorLow = Math.min(...lows.slice(-144, -72));
  const lowerLows = priorLow > 0 && recentLow < priorLow * 0.97;

  const atrValue = atr(candles, 14);
  const atrPercent = last > 0 ? atrValue / last : 0;

  // Recovery ratio proxy: how often price revisits the median after deep pullbacks.
  const window = closes.slice(-160);
  const median = percentile(window, 0.50);
  const oversold = percentile(window, 0.12);
  const episodes = [];
  let inDip = false;
  let dipLow = null;
  let recovered = false;
  for (const v of window) {
    if (!inDip && v > 0 && v <= oversold) {
      inDip = true;
      dipLow = v;
      recovered = false;
      continue;
    }
    if (inDip) {
      dipLow = Math.min(dipLow, v);
      if (!recovered && v >= median) recovered = true;
      if (recovered && v >= median) {
        episodes.push({ dipLow, recovered: true });
        inDip = false;
      }
    }
  }
  const recoveryRate = episodes.length > 0 ? episodes.filter((e) => e.recovered).length / episodes.length : 0;

  const cyclical = amplitude >= 0.16 && recoveryRate >= 0.55;
  const structuralReject = lowerHighs && lowerLows;

  const waveScore = clamp(
    (clamp(amplitude / 0.35, 0, 1) * 0.34)
      + (clamp(recoveryRate / 0.85, 0, 1) * 0.38)
      + (clamp(atrPercent / 0.06, 0, 1) * 0.18)
      - (structuralReject ? 0.35 : 0),
    0,
    1
  );

  if (!cyclical) {
    return { eligible: false, waveScore, reason: 'not cyclical enough' };
  }
  if (structuralReject) {
    return { eligible: false, waveScore, reason: 'structural downtrend' };
  }

  return { eligible: true, waveScore, reason: 'qualified' };
}

function dynamicBuyZone(candles) {
  const closes = candles.map(close).filter((v) => v > 0);
  const last = closes[closes.length - 1] || 0;
  const window = closes.slice(-160);
  const p05 = percentile(window, 0.05);
  const p10 = percentile(window, 0.10);
  const atrValue = atr(candles, 14);
  const band = atrValue * 1.2;
  const zoneHigh = p10 + band;
  const zoneLow = Math.max(0, p05 - band * 0.35);
  return { inZone: last > 0 && last >= zoneLow && last <= zoneHigh, zoneLow, zoneHigh, last };
}

function dynamicSellZone(candles) {
  const closes = candles.map(close).filter((v) => v > 0);
  const window = closes.slice(-160);
  const p55 = percentile(window, 0.55);
  const p68 = percentile(window, 0.68);
  return { targetLow: p55, targetHigh: p68 };
}

class WaveHunterAgent {
  constructor(services) {
    this.analyzer = services.analyzer;
    this.portfolio = services.portfolio;
    this.sentiment = services.sentiment;
    this.scanner = services.scanner;
    this.storage = services.storage;
    this.exchange = services.exchange;
    this.alerts = services.alerts;
    this.marketRegime = services.marketRegime;
    this.config = services.config;
    this.logger = services.logger;
    this.strategyKey = 'wavehunter';
  }

  async tick({ source = 'scheduler' } = {}) {
    await this.manageOpenPositions();
    const settings = await this.storage.strategySettingsRef(this.strategyKey).get().then((snap) => (snap.exists ? snap.data() : { paused: false }));
    if (settings.paused) return { paused: true, signals: [] };
    const signals = await this.findEntries(settings, source);
    return { paused: false, signals };
  }

  async manageOpenPositions() {
    const positions = await this.storage.getOpenPositions(this.strategyKey);
    for (const position of positions) {
      try {
        const candles = await this.exchange.getOhlcv(position.symbol, this.config.exchange.higherTimeframe, this.config.exchange.higherTimeframeLimit);
        const metrics = await this.analyzer.analyzeSymbol(position.symbol);
        const symbolSentiment = await this.sentiment.getSentiment(position.symbol);
        const sellZone = dynamicSellZone(candles);
        const last = Number(metrics.price || 0);
        const target = Math.max(sellZone.targetLow, position.entryPrice * 1.02);

        // WaveHunter exit: recovery into realistic zone + weakening momentum, or structural invalidation.
        const qualification = waveQualification(candles);
        const invalidated = !qualification.eligible && qualification.reason === 'structural downtrend';
        const recovered = last > 0 && last >= target;
        const momentumWeakening = Number(metrics.recentMomentum || 0) < 0.001 && Number(metrics.acceleration || 0) <= 0;

        if (invalidated) {
          const result = await this.portfolio.closePosition({
            strategyKey: this.strategyKey,
            symbol: position.symbol,
            price: metrics.price,
            metrics,
            sentiment: symbolSentiment,
            reason: 'wave invalidated: structural downtrend'
          });
          if (result.executed) {
            await this.alerts.sendTradeAlert({
              strategyKey: this.strategyKey,
              side: 'SELL',
              symbol: position.symbol,
              price: metrics.price,
              quantity: result.position.quantity,
              notional: result.position.quantity * metrics.price,
              pnl: result.position.realizedPnl,
              pnlPct: result.position.realizedPnlPct,
              reason: 'wave invalidated: structural downtrend'
            });
          }
          continue;
        }

        if (recovered && momentumWeakening) {
          const result = await this.portfolio.closePosition({
            strategyKey: this.strategyKey,
            symbol: position.symbol,
            price: metrics.price,
            metrics,
            sentiment: symbolSentiment,
            reason: 'recovery reached; momentum weakening'
          });
          if (result.executed) {
            await this.alerts.sendTradeAlert({
              strategyKey: this.strategyKey,
              side: 'SELL',
              symbol: position.symbol,
              price: metrics.price,
              quantity: result.position.quantity,
              notional: result.position.quantity * metrics.price,
              pnl: result.position.realizedPnl,
              pnlPct: result.position.realizedPnlPct,
              reason: 'recovery reached; momentum weakening'
            });
          }
        }
      } catch (error) {
        this.logger.error('WaveHunter failed to manage open position', { symbol: position.symbol, error });
      }
    }
  }

  async findEntries(settings, source) {
    const watchlist = await this.scanner.getWatchlist();
    const openPositions = await this.storage.getOpenPositions(this.strategyKey);
    const openBySymbol = new Map(openPositions.map((position) => [position.symbol, position]));
    const [snapshot, marketRegime] = await Promise.all([
      this.portfolio.getSnapshot({ strategyKey: this.strategyKey }),
      this.marketRegime.getCurrent().catch(() => null)
    ]);
    const signals = [];

    await this.exchange.getTickers(watchlist);

    for (const symbol of watchlist) {
      try {
        if (openBySymbol.get(symbol)) continue;
        const candles = await this.exchange.getOhlcv(symbol, this.config.exchange.higherTimeframe, Math.max(160, this.config.exchange.higherTimeframeLimit));
        const qualification = waveQualification(candles);
        if (!qualification.eligible || qualification.waveScore < 0.55) continue;

        const zone = dynamicBuyZone(candles);
        if (!zone.inZone) continue;

        const metrics = await this.analyzer.analyzeSymbol(symbol);
        const symbolSentiment = await this.sentiment.getSentiment(symbol);

        // WaveHunter does not blindly buy dips: require liquidity and avoid panic regimes.
        if (metrics.quoteVolume < this.config.scanner.minQuoteVolumeUsdt) continue;
        if (marketRegime && ['high_volatility_chaos', 'low_liquidity'].includes(marketRegime.regime)) continue;

        const confidence = clamp(
          (qualification.waveScore * 0.55)
            + (clamp(metrics.liquidityScore || 0, 0, 1) * 0.2)
            + (clamp((metrics.volatilityScore || 0) / 1, 0, 1) * 0.15)
            + (symbolSentiment && symbolSentiment.label === 'bearish' ? -0.05 : 0.03),
          0,
          1
        );

        const reason = [
          'wave bottom zone',
          `waveScore ${Math.round(qualification.waveScore * 100)}%`,
          `buyZone ${zone.zoneLow.toFixed(6)}..${zone.zoneHigh.toFixed(6)}`,
          `regime ${marketRegime ? marketRegime.regime : 'unknown'}`
        ].join(', ');

        const result = await this.portfolio.openPosition({
          strategyKey: this.strategyKey,
          symbol,
          metrics,
          sentiment: symbolSentiment,
          confidence,
          reason,
          marketRegime
        });
        if (!result.executed) continue;

        openPositions.push(result.position);
        signals.push({ symbol, metrics, confidence, reason });

        await this.alerts.sendSignalAlert({
          strategyKey: this.strategyKey,
          symbol,
          metrics,
          confidence,
          stopLossPrice: null,
          takeProfitPrice: null,
          reason
        });
        await this.alerts.sendTradeAlert({
          strategyKey: this.strategyKey,
          side: 'BUY',
          symbol,
          price: metrics.price,
          quantity: result.position.quantity,
          notional: result.position.notional,
          reason
        });
      } catch (error) {
        this.logger.error('WaveHunter failed to evaluate entry', { symbol, error });
      }
    }

    return signals;
  }
}

module.exports = WaveHunterAgent;

