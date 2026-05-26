'use strict';

const { FieldValue } = require('../firebase');
const { sanitizeId, toMillis, uniqueSymbols } = require('../utils/format');

function nowDate() {
  return new Date();
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

class FirestoreStorage {
  constructor({ db, config, logger, instanceId }) {
    this.db = db;
    this.config = config;
    this.logger = logger;
    this.instanceId = instanceId;
    this.lastPriceCache = new Map();
    this.lastWatchlistKey = null;
    this.cooldownCache = new Map();
  }

  settingsRef() {
    return this.db.collection('settings').doc('main');
  }

  portfolioRef(strategyKey) {
    if (!strategyKey || strategyKey === 'legacy') {
      return this.db.collection('portfolio').doc('paper');
    }
    return this.db.collection('strategyPortfolios').doc(String(strategyKey));
  }

  strategySettingsRef(strategyKey) {
    return this.db.collection('strategySettings').doc(String(strategyKey));
  }

  watchlistRef() {
    return this.db.collection('watchlists').doc('active');
  }

  blacklistRef() {
    return this.db.collection('blacklists').doc('custom');
  }

  positionsCollection() {
    return this.db.collection('positions');
  }

  positionRef(symbol, strategyKey) {
    if (!strategyKey || strategyKey === 'legacy') {
      return this.positionsCollection().doc(sanitizeId(symbol));
    }
    return this.positionsCollection().doc(sanitizeId(`${strategyKey}__${symbol}`));
  }

  tradesCollection() {
    return this.db.collection('trades');
  }

  alertsCollection() {
    return this.db.collection('alerts');
  }

  cooldownRef(key) {
    return this.db.collection('cooldowns').doc(sanitizeId(key));
  }

  lockRef(name) {
    return this.db.collection('locks').doc(sanitizeId(name));
  }

  rankingRef(symbol) {
    return this.db.collection('volatilityRankings').doc(sanitizeId(symbol));
  }

  sentimentLatestRef(symbol) {
    return this.db.collection('sentimentLatest').doc(sanitizeId(symbol));
  }

  lastKnownPriceRef(symbol) {
    return this.db.collection('lastKnownPrices').doc(sanitizeId(symbol));
  }

  analyticsRef() {
    return this.db.collection('analytics').doc('performance');
  }

  strategyAnalyticsRef(strategyKey) {
    return this.db.collection('strategyAnalytics').doc(String(strategyKey));
  }

  strategyDiagnosticsRef() {
    return this.db.collection('strategyDiagnostics').doc('current');
  }

  marketRegimeRef() {
    return this.db.collection('marketRegime').doc('current');
  }

  async ensureBootstrap() {
    const now = nowDate();
    const [settingsSnap, portfolioSnap, watchlistSnap, blacklistSnap] = await Promise.all([
      this.settingsRef().get(),
      this.portfolioRef().get(),
      this.watchlistRef().get(),
      this.blacklistRef().get()
    ]);

    const batch = this.db.batch();

    if (!settingsSnap.exists) {
      batch.set(this.settingsRef(), {
        paused: false,
        createdAt: now,
        updatedAt: now,
        appName: this.config.appName
      });
    }

    if (!portfolioSnap.exists) {
      batch.set(this.portfolioRef(), {
        cash: this.config.risk.paperStartBalance,
        startBalance: this.config.risk.paperStartBalance,
        baseSymbol: this.config.exchange.baseSymbol,
        realizedPnl: 0,
        equity: this.config.risk.paperStartBalance,
        createdAt: now,
        updatedAt: now
      });
    }

    if (!watchlistSnap.exists) {
      batch.set(this.watchlistRef(), {
        symbols: uniqueSymbols(this.config.scanner.initialWatchlist),
        updatedAt: now,
        source: 'env'
      });
    }

    if (!blacklistSnap.exists) {
      batch.set(this.blacklistRef(), {
        symbols: [],
        updatedAt: now
      });
    }

    await batch.commit();

    await this.ensureStrategyBootstrap(now).catch((error) => {
      this.logger.warn('Strategy bootstrap skipped or failed', { error });
    });
  }

  async ensureStrategyBootstrap(now = nowDate()) {
    const strategyKeys = ['wavehunter', 'momentumpulse', 'whaleshadow', 'sentinelmind'];
    const startBalance = Number(this.config.risk.paperStartBalance || 100);
    const perStrategy = startBalance / strategyKeys.length;

    const refs = strategyKeys.flatMap((key) => [this.portfolioRef(key), this.strategySettingsRef(key)]);
    const snaps = await Promise.all(refs.map((ref) => ref.get()));
    const batch = this.db.batch();
    for (let i = 0; i < strategyKeys.length; i += 1) {
      const key = strategyKeys[i];
      const portfolioSnap = snaps[i * 2];
      const settingsSnap = snaps[i * 2 + 1];

      if (!portfolioSnap.exists) {
        batch.set(this.portfolioRef(key), {
          strategyKey: key,
          cash: perStrategy,
          startBalance: perStrategy,
          baseSymbol: this.config.exchange.baseSymbol,
          realizedPnl: 0,
          equity: perStrategy,
          createdAt: now,
          updatedAt: now
        });
      }

      if (!settingsSnap.exists) {
        batch.set(this.strategySettingsRef(key), {
          strategyKey: key,
          paused: false,
          aggressiveness: 0.55,
          maxOpenPositions: Math.max(1, Math.floor(Number(this.config.risk.maxOpenPositions || 4) / 2)),
          createdAt: now,
          updatedAt: now
        });
      }
    }
    await batch.commit();
  }

  async checkConnection() {
    const ref = this.db.collection('_health').doc('firestore');
    await ref.set({
      checkedAt: nowDate(),
      instanceId: this.instanceId
    }, { merge: true });
    return true;
  }

  async getSettings() {
    const snap = await this.settingsRef().get();
    return snap.exists ? snap.data() : { paused: false };
  }

  async updateSettings(patch) {
    await this.settingsRef().set({
      ...patch,
      updatedAt: nowDate()
    }, { merge: true });
    return this.getSettings();
  }

  async setPaused(paused) {
    return this.updateSettings({ paused: Boolean(paused) });
  }

  async getWatchlist() {
    const snap = await this.watchlistRef().get();
    const symbols = snap.exists
      ? uniqueSymbols(snap.data().symbols || [])
      : uniqueSymbols(this.config.scanner.initialWatchlist);
    this.lastWatchlistKey = symbols.join(',');
    return symbols;
  }

  async saveWatchlist(symbols, source = 'scanner') {
    const normalized = uniqueSymbols(symbols).slice(0, this.config.scanner.maxWatchlistSize);
    const key = normalized.join(',');
    if (this.lastWatchlistKey === key) return normalized;
    await this.watchlistRef().set({
      symbols: normalized,
      source,
      updatedAt: nowDate()
    }, { merge: true });
    this.lastWatchlistKey = key;
    return normalized;
  }

  async getCustomBlacklist() {
    const snap = await this.blacklistRef().get();
    if (!snap.exists) return [];
    return uniqueSymbols(snap.data().symbols || []);
  }

  async saveCustomBlacklist(symbols) {
    const normalized = uniqueSymbols(symbols);
    await this.blacklistRef().set({
      symbols: normalized,
      updatedAt: nowDate()
    }, { merge: true });
    return normalized;
  }

  async getPortfolio(strategyKey) {
    const snap = await this.portfolioRef(strategyKey).get();
    return snap.exists ? snap.data() : null;
  }

  async savePortfolio(patch, strategyKey) {
    await this.portfolioRef(strategyKey).set({
      ...patch,
      updatedAt: nowDate()
    }, { merge: true });
  }

  async getOpenPositions(strategyKey) {
    const snap = await this.positionsCollection()
      .where('status', '==', 'open')
      .get();
    const rows = snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => toMillis(a.openedAt) - toMillis(b.openedAt));
    if (!strategyKey) return rows;
    return rows.filter((row) => String(row.strategyKey || 'legacy') === String(strategyKey));
  }

  async getClosedPositions(limit = 250, strategyKey) {
    const snap = await this.positionsCollection()
      .where('status', '==', 'closed')
      .limit(limit)
      .get();
    const rows = snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => toMillis(b.closedAt) - toMillis(a.closedAt));
    if (!strategyKey) return rows;
    return rows.filter((row) => String(row.strategyKey || 'legacy') === String(strategyKey));
  }

  async getPosition(symbol, strategyKey) {
    const snap = await this.positionRef(symbol, strategyKey).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  }

  async getRecentTrades(limit = 10, strategyKey) {
    const snap = await this.tradesCollection()
      .orderBy('executedAt', 'desc')
      .limit(limit)
      .get();
    const rows = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    if (!strategyKey) return rows;
    return rows.filter((row) => String(row.strategyKey || 'legacy') === String(strategyKey));
  }

  async getTrades(limit = 500, strategyKey) {
    const snap = await this.tradesCollection()
      .orderBy('executedAt', 'desc')
      .limit(limit)
      .get();
    const rows = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    if (!strategyKey) return rows;
    return rows.filter((row) => String(row.strategyKey || 'legacy') === String(strategyKey));
  }

  async getActiveCooldowns(limit = 50) {
    const snap = await this.db.collection('cooldowns')
      .where('expiresAt', '>', nowDate())
      .limit(limit)
      .get();
    return snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => toMillis(a.expiresAt) - toMillis(b.expiresAt));
  }

  async saveAlert(alert) {
    const ref = this.alertsCollection().doc();
    await ref.set({
      ...alert,
      createdAt: nowDate()
    });
    return ref.id;
  }

  async isCooldownActive(key) {
    const cached = this.cooldownCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return true;
    if (cached && cached.expiresAt <= Date.now()) this.cooldownCache.delete(key);

    const snap = await this.cooldownRef(key).get();
    if (!snap.exists) return false;
    const expiresAt = toMillis(snap.data().expiresAt);
    const active = expiresAt > Date.now();
    if (active) {
      this.cooldownCache.set(key, { expiresAt });
    }
    return active;
  }

  async setCooldown(key, ttlMs, meta = {}) {
    const expiresAt = new Date(Date.now() + ttlMs);
    this.cooldownCache.set(key, { expiresAt: expiresAt.getTime() });
    await this.cooldownRef(key).set({
      key,
      expiresAt,
      updatedAt: nowDate(),
      ...meta
    }, { merge: true });
    return expiresAt;
  }

  async clearCooldown(key) {
    this.cooldownCache.delete(key);
    await this.cooldownRef(key).delete();
  }

  async acquireLock(name, ttlMs) {
    const ref = this.lockRef(name);
    const owner = this.instanceId;
    const expiresAt = new Date(Date.now() + ttlMs);

    return this.db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      if (snap.exists) {
        const lock = snap.data();
        if (toMillis(lock.expiresAt) > Date.now() && lock.owner !== owner) {
          return null;
        }
      }

      const token = `${owner}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
      transaction.set(ref, {
        name,
        owner,
        token,
        expiresAt,
        acquiredAt: nowDate(),
        updatedAt: nowDate()
      }, { merge: true });
      return token;
    });
  }

  async releaseLock(name, token) {
    if (!token) return;
    const ref = this.lockRef(name);
    await this.db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      if (!snap.exists) return;
      if (snap.data().token === token) {
        transaction.delete(ref);
      }
    });
  }

  async saveVolatilityRankings(rankings) {
    const now = nowDate();
    const rows = rankings.slice(0, 150);
    await this.writeBatches(rows, (batch, ranking, index) => {
      batch.set(this.rankingRef(ranking.symbol), {
        ...ranking,
        rank: index + 1,
        updatedAt: now
      }, { merge: true });
    });

    await this.db.collection('state').doc('volatility').set({
      updatedAt: now,
      count: rows.length,
      topSymbols: rows.slice(0, 20).map((item) => item.symbol)
    }, { merge: true });
  }

  async getTopVolatility(limit = 10) {
    const snap = await this.db.collection('volatilityRankings')
      .orderBy('rankScore', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  async getVolatilityRank(symbol) {
    const snap = await this.rankingRef(symbol).get();
    return snap.exists ? snap.data() : null;
  }

  async saveAnalyticsSnapshot(analytics) {
    const now = nowDate();
    const historyRef = this.db.collection('analyticsHistory').doc();
    const payload = {
      ...analytics,
      updatedAt: now
    };
    const batch = this.db.batch();
    batch.set(this.analyticsRef(), payload, { merge: true });
    batch.set(historyRef, payload);
    await batch.commit();
  }

  async saveStrategyAnalyticsSnapshot(strategyKey, analytics) {
    const now = nowDate();
    const historyRef = this.db.collection('strategyAnalyticsHistory').doc();
    const payload = {
      ...analytics,
      strategyKey,
      updatedAt: now
    };
    const batch = this.db.batch();
    batch.set(this.strategyAnalyticsRef(strategyKey), payload, { merge: true });
    batch.set(historyRef, payload);
    await batch.commit();
  }

  async getLatestStrategyAnalytics(strategyKey) {
    const snap = await this.strategyAnalyticsRef(strategyKey).get();
    return snap.exists ? snap.data() : null;
  }

  async getLatestAnalytics() {
    const snap = await this.analyticsRef().get();
    return snap.exists ? snap.data() : null;
  }

  async saveStrategyDiagnostics(diagnostics) {
    await this.strategyDiagnosticsRef().set({
      ...diagnostics,
      updatedAt: nowDate()
    }, { merge: true });
  }

  async getStrategyDiagnostics() {
    const snap = await this.strategyDiagnosticsRef().get();
    return snap.exists ? snap.data() : null;
  }

  async saveMarketRegime(regime) {
    await this.marketRegimeRef().set({
      ...regime,
      updatedAt: nowDate()
    }, { merge: true });
  }

  async getMarketRegime() {
    const snap = await this.marketRegimeRef().get();
    return snap.exists ? snap.data() : null;
  }

  async saveSentiment(symbol, result) {
    const now = nowDate();
    const cleanSymbol = String(symbol || 'MARKET').toUpperCase();
    const historyRef = this.db.collection('sentimentHistory').doc();
    const payload = {
      symbol: cleanSymbol,
      label: result.label,
      score: result.score,
      confidence: result.confidence,
      source: result.source,
      headlineCount: result.headlineCount || 0,
      headlines: result.headlines || [],
      updatedAt: now
    };

    const batch = this.db.batch();
    batch.set(historyRef, payload);
    batch.set(this.sentimentLatestRef(cleanSymbol), payload, { merge: true });
    await batch.commit();
  }

  async getLatestSentiment(symbol) {
    const snap = await this.sentimentLatestRef(symbol || 'MARKET').get();
    return snap.exists ? snap.data() : null;
  }

  async updateLastKnownPrices(tickers) {
    const now = nowDate();
    const entries = Object.entries(tickers || {}).filter(([symbol, ticker]) => {
      if (!ticker || !ticker.last) return false;
      const last = this.lastPriceCache.get(symbol);
      const price = Number(ticker.last);
      const changed = !last || Math.abs(price - last.price) / Math.max(price, 1) >= 0.001;
      const stale = !last || Date.now() - last.updatedAt >= this.config.storage.portfolioSnapshotMinSeconds * 1000;
      if (changed || stale) {
        this.lastPriceCache.set(symbol, { price, updatedAt: Date.now() });
        return true;
      }
      return false;
    });
    if (entries.length === 0) return;
    await this.writeBatches(entries, (batch, [symbol, ticker]) => {
      batch.set(this.lastKnownPriceRef(symbol), {
        symbol,
        price: Number(ticker.last),
        bid: Number(ticker.bid || 0),
        ask: Number(ticker.ask || 0),
        quoteVolume: Number(ticker.quoteVolume || ticker.baseVolume || 0),
        percentage: Number(ticker.percentage || 0),
        updatedAt: now
      }, { merge: true });
    });
  }

  async getLastKnownPrice(symbol) {
    const snap = await this.lastKnownPriceRef(symbol).get();
    return snap.exists ? snap.data() : null;
  }

  async createTrade(transaction, trade) {
    const ref = this.tradesCollection().doc();
    transaction.set(ref, {
      ...trade,
      paper: true,
      executedAt: nowDate()
    });
    return ref.id;
  }

  async resetPaperPortfolio() {
    await this.deleteCollection(this.positionsCollection(), 250);
    await this.deleteCollection(this.tradesCollection(), 250);
    await this.analyticsRef().delete().catch(() => undefined);
    await this.portfolioRef().set({
      cash: this.config.risk.paperStartBalance,
      startBalance: this.config.risk.paperStartBalance,
      baseSymbol: this.config.exchange.baseSymbol,
      realizedPnl: 0,
      equity: this.config.risk.paperStartBalance,
      resetAt: nowDate(),
      updatedAt: nowDate()
    }, { merge: false });
  }

  async cleanupStaleData() {
    const now = nowDate();
    const results = {
      cooldowns: await this.deleteWhere(this.db.collection('cooldowns'), 'expiresAt', '<=', now),
      alerts: await this.deleteWhere(this.alertsCollection(), 'createdAt', '<=', addDays(now, -this.config.storage.staleAlertsDays)),
      sentiment: await this.deleteWhere(this.db.collection('sentimentHistory'), 'updatedAt', '<=', addDays(now, -this.config.storage.staleSentimentDays)),
      rankings: await this.deleteWhere(this.db.collection('volatilityRankings'), 'updatedAt', '<=', addDays(now, -this.config.storage.staleRankingsDays)),
      prices: await this.deleteWhere(this.db.collection('lastKnownPrices'), 'updatedAt', '<=', addDays(now, -this.config.storage.stalePricesDays)),
      analyticsHistory: await this.deleteWhere(this.db.collection('analyticsHistory'), 'updatedAt', '<=', addDays(now, -30))
    };
    this.logger.info('Firestore stale data cleanup complete', results);
    return results;
  }

  async deleteWhere(collectionRef, field, operator, value, batchSize = 250) {
    let total = 0;
    while (true) {
      const snap = await collectionRef.where(field, operator, value).limit(batchSize).get();
      if (snap.empty) break;
      const batch = this.db.batch();
      snap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      total += snap.size;
      if (snap.size < batchSize) break;
    }
    return total;
  }

  async deleteCollection(collectionRef, batchSize = 250) {
    let total = 0;
    while (true) {
      const snap = await collectionRef.limit(batchSize).get();
      if (snap.empty) break;
      const batch = this.db.batch();
      snap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      total += snap.size;
      if (snap.size < batchSize) break;
    }
    return total;
  }

  async writeBatches(items, writer, size = 450) {
    for (let start = 0; start < items.length; start += size) {
      const batch = this.db.batch();
      items.slice(start, start + size).forEach((item, index) => writer(batch, item, start + index));
      await batch.commit();
    }
  }

  serverTimestamp() {
    return FieldValue.serverTimestamp();
  }
}

module.exports = FirestoreStorage;
