'use strict';

const { mapLimit } = require('../utils/concurrency');
const { uniqueSymbols } = require('../utils/format');

class ScannerService {
  constructor({ exchange, analyzer, blacklist, storage, config, logger }) {
    this.exchange = exchange;
    this.analyzer = analyzer;
    this.blacklist = blacklist;
    this.storage = storage;
    this.config = config;
    this.logger = logger;
    this.running = false;
  }

  async scanVolatile({ force = false, limit = 100 } = {}) {
    if (this.running && !force) {
      this.logger.warn('Volatility scan skipped because a scan is already running');
      return this.storage.getTopVolatility(10);
    }

    this.running = true;
    try {
      await this.exchange.loadMarkets();
      const markets = await this.exchange.getSpotUsdtMarkets();
      const tickers = await this.exchange.refreshTickers();

      const candidates = markets
        .map((market) => {
          const symbol = market.symbol.toUpperCase();
          const ticker = tickers[symbol];
          const blacklistReason = this.blacklist.getReason(symbol, market);
          const quoteVolume = Number(ticker && (ticker.quoteVolume || ticker.baseVolume || 0));
          const last = Number(ticker && ticker.last);
          const spread = ticker ? this.exchange.getSpread(ticker) : null;

          return {
            symbol,
            market,
            ticker,
            quoteVolume,
            last,
            spread,
            blacklistReason
          };
        })
        .filter((item) => item.ticker)
        .filter((item) => !item.blacklistReason)
        .filter((item) => item.last > 0)
        .filter((item) => item.quoteVolume >= this.config.scanner.minQuoteVolumeUsdt)
        .filter((item) => item.spread === null || item.spread <= this.config.scanner.maxSpread)
        .sort((a, b) => {
          const aMove = Math.abs(Number(a.ticker.percentage || 0));
          const bMove = Math.abs(Number(b.ticker.percentage || 0));
          return (bMove + Math.log10(b.quoteVolume + 1)) - (aMove + Math.log10(a.quoteVolume + 1));
        })
        .slice(0, this.config.scanner.candidateLimit);

      const analyzed = await mapLimit(candidates, 4, async (candidate) => {
        try {
          const oldEnough = await this.analyzer.hasMinimumMarketAge(candidate.symbol);
          if (!oldEnough) return null;
          const metrics = await this.analyzer.analyzeSymbol(candidate.symbol);
          if (this.config.scanner.minMarketCapUsd > 0
            && metrics.marketCapUsd
            && metrics.marketCapUsd < this.config.scanner.minMarketCapUsd) {
            return null;
          }
          return metrics;
        } catch (error) {
          this.logger.warn('Failed to analyze volatility candidate', {
            symbol: candidate.symbol,
            error
          });
          return null;
        }
      });

      const ranked = analyzed
        .filter(Boolean)
        .filter((item) => item.volatilityScore >= this.config.scanner.minVolatilityScore || item.momentumScore > 0.5)
        .sort((a, b) => b.rankScore - a.rankScore)
        .slice(0, limit);

      await this.storage.saveVolatilityRankings(ranked);

      if (this.config.scanner.autoDiscoverVolatile) {
        await this.updateWatchlist(ranked);
      }

      this.logger.signal('Volatility scan complete', {
        candidates: candidates.length,
        ranked: ranked.length,
        top: ranked.slice(0, 5).map((item) => item.symbol)
      });

      return ranked;
    } finally {
      this.running = false;
    }
  }

  async updateWatchlist(ranked) {
    const current = await this.storage.getWatchlist();
    const discovered = ranked
      .filter((item) => {
        if (!this.config.scanner.memeMode) return true;
        return item.memeScore > 0 || item.volatilityScore > 0.65 || item.volumeRatio >= 1.6;
      })
      .map((item) => item.symbol);

    const combined = uniqueSymbols([
      ...this.config.scanner.initialWatchlist,
      ...discovered,
      ...current
    ]).slice(0, this.config.scanner.maxWatchlistSize);

    await this.storage.saveWatchlist(combined, 'scanner');
    return combined;
  }

  async getWatchlist() {
    return this.storage.getWatchlist();
  }

  async getTopVolatile(limit = 10) {
    return this.storage.getTopVolatility(limit);
  }
}

module.exports = ScannerService;
