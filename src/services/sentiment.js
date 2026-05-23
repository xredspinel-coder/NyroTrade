'use strict';

const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { mapLimit } = require('../utils/concurrency');
const { clamp, toMillis } = require('../utils/format');
const { withRetry } = require('../utils/retry');

const BULLISH = [
  'surge', 'rally', 'breakout', 'bullish', 'accumulat', 'record high', 'inflows',
  'approval', 'partnership', 'listing', 'adoption', 'upgrade', 'beats', 'soars',
  'rebounds', 'recover', 'whale buys', 'open interest rises'
];

const BEARISH = [
  'crash', 'plunge', 'selloff', 'bearish', 'hack', 'exploit', 'lawsuit',
  'investigation', 'ban', 'outflows', 'liquidation', 'falls', 'drops', 'slumps',
  'scam', 'rug', 'delist', 'warning', 'fraud'
];

const ALIASES = {
  DOGE: ['doge', 'dogecoin'],
  SHIB: ['shib', 'shiba'],
  PEPE: ['pepe'],
  WIF: ['wif', 'dogwifhat'],
  BONK: ['bonk'],
  FLOKI: ['floki'],
  TURBO: ['turbo'],
  BTC: ['btc', 'bitcoin'],
  ETH: ['eth', 'ethereum'],
  SOL: ['sol', 'solana']
};

class SentimentService {
  constructor({ storage, config, logger }) {
    this.storage = storage;
    this.config = config;
    this.logger = logger;
    this.parser = new XMLParser({ ignoreAttributes: false });
    this.cache = new Map();
    this.latestUpdate = null;
  }

  async refresh(symbols = []) {
    const news = await this.fetchNews();
    const targets = Array.from(new Set(['MARKET', ...symbols.map((symbol) => symbol.toUpperCase())]));
    await mapLimit(targets, 2, async (symbol) => {
      const result = await this.analyzeSymbol(symbol, news);
      this.cache.set(symbol, {
        ...result,
        updatedAt: new Date().toISOString()
      });
      await this.storage.saveSentiment(symbol, result);
    });
    this.latestUpdate = new Date().toISOString();
    this.logger.info('Sentiment refresh complete', {
      symbols: targets.length,
      headlines: news.length
    });
  }

  async fetchNews() {
    const responses = await Promise.allSettled(this.config.sentiment.sources.map(async (url) => {
      const response = await withRetry(
        () => axios.get(url, {
          timeout: this.config.sentiment.timeoutMs,
          headers: {
            'User-Agent': 'NyroTrade/1.0 crypto paper trading monitor'
          }
        }),
        {
          label: `news.${url}`,
          retries: 2,
          timeoutMs: this.config.sentiment.timeoutMs,
          logger: this.logger
        }
      );
      return this.parseFeed(url, response.data);
    }));

    const items = [];
    for (const result of responses) {
      if (result.status === 'fulfilled') {
        items.push(...result.value);
      } else {
        this.logger.warn('News source failed', { error: result.reason });
      }
    }

    return items
      .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
      .slice(0, 80);
  }

  parseFeed(source, xml) {
    const parsed = this.parser.parse(xml);
    const channel = parsed && parsed.rss && parsed.rss.channel;
    const rawItems = channel && channel.item
      ? (Array.isArray(channel.item) ? channel.item : [channel.item])
      : [];

    return rawItems.map((item) => ({
      source,
      title: this.cleanText(item.title),
      summary: this.cleanText(item.description || item['content:encoded'] || ''),
      link: item.link || '',
      publishedAt: item.pubDate || item.isoDate || null
    })).filter((item) => item.title);
  }

  cleanText(value) {
    return String(value || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async analyzeSymbol(symbol, news) {
    const relevant = this.relevantNews(symbol, news).slice(0, 10);
    if (this.config.sentiment.ollamaUrl && relevant.length > 0) {
      try {
        return await this.analyzeWithOllama(symbol, relevant);
      } catch (error) {
        this.logger.warn('Ollama sentiment failed; using keyword fallback', {
          symbol,
          error
        });
      }
    }

    return this.keywordSentiment(symbol, relevant);
  }

  relevantNews(symbol, news) {
    if (symbol === 'MARKET') {
      return news.filter((item) => /crypto|bitcoin|ethereum|altcoin|token|binance|market/i.test(`${item.title} ${item.summary}`));
    }

    const base = symbol.split('/')[0];
    const aliases = ALIASES[base] || [base.toLowerCase()];
    return news.filter((item) => {
      const text = `${item.title} ${item.summary}`.toLowerCase();
      return aliases.some((alias) => text.includes(alias.toLowerCase()));
    });
  }

  async analyzeWithOllama(symbol, items) {
    const prompt = [
      'Classify crypto news sentiment for a paper trading monitor.',
      'Return only JSON with keys label, score, confidence.',
      'label must be bullish, bearish, or neutral. score must be from -1 to 1.',
      `Symbol: ${symbol}`,
      'Headlines:',
      ...items.map((item, index) => `${index + 1}. ${item.title}`)
    ].join('\n');

    const response = await withRetry(
      () => axios.post(`${this.config.sentiment.ollamaUrl}/api/generate`, {
        model: this.config.sentiment.ollamaModel,
        prompt,
        stream: false,
        options: {
          temperature: 0.1
        }
      }, {
        timeout: this.config.sentiment.timeoutMs
      }),
      {
        label: `ollama.sentiment.${symbol}`,
        retries: 1,
        timeoutMs: this.config.sentiment.timeoutMs,
        logger: this.logger
      }
    );

    const raw = response.data && response.data.response ? response.data.response : '{}';
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);
    return this.normalizeSentiment({
      label: parsed.label,
      score: Number(parsed.score),
      confidence: Number(parsed.confidence),
      source: 'ollama',
      headlineCount: items.length,
      headlines: items.slice(0, 5).map((item) => item.title)
    });
  }

  keywordSentiment(symbol, items) {
    let score = 0;
    for (const item of items) {
      const text = `${item.title} ${item.summary}`.toLowerCase();
      for (const keyword of BULLISH) {
        if (text.includes(keyword)) score += 0.2;
      }
      for (const keyword of BEARISH) {
        if (text.includes(keyword)) score -= 0.25;
      }
    }

    const normalized = items.length > 0 ? clamp(score / Math.max(1, items.length), -1, 1) : 0;
    return this.normalizeSentiment({
      score: normalized,
      confidence: items.length > 0 ? clamp(Math.abs(normalized) + 0.35, 0.35, 0.85) : 0.3,
      source: 'keywords',
      headlineCount: items.length,
      headlines: items.slice(0, 5).map((item) => item.title)
    });
  }

  normalizeSentiment(result) {
    const rawScore = Number(result.score);
    const score = clamp(Number.isFinite(rawScore) ? rawScore : 0, -1, 1);
    const label = result.label && ['bullish', 'bearish', 'neutral'].includes(String(result.label).toLowerCase())
      ? String(result.label).toLowerCase()
      : (score > 0.15 ? 'bullish' : score < -0.15 ? 'bearish' : 'neutral');
    return {
      label,
      score,
      confidence: clamp(Number(result.confidence || 0.4), 0, 1),
      source: result.source || 'keywords',
      headlineCount: result.headlineCount || 0,
      headlines: result.headlines || []
    };
  }

  async getSentiment(symbol) {
    const normalized = String(symbol || 'MARKET').toUpperCase();
    const cached = this.cache.get(normalized);
    const maxAgeMs = this.config.scheduler.sentimentRefreshMinutes * 2 * 60 * 1000;
    if (cached && Date.now() - Date.parse(cached.updatedAt) < maxAgeMs) {
      return cached;
    }

    const latest = await this.storage.getLatestSentiment(normalized);
    if (latest) {
      const result = {
        label: latest.label,
        score: latest.score,
        confidence: latest.confidence,
        source: latest.source,
        headlineCount: latest.headlineCount,
        headlines: latest.headlines || [],
        updatedAt: toMillis(latest.updatedAt) ? new Date(toMillis(latest.updatedAt)).toISOString() : new Date().toISOString()
      };
      this.cache.set(normalized, result);
      return result;
    }

    return {
      label: 'neutral',
      score: 0,
      confidence: 0.3,
      source: 'default',
      headlineCount: 0,
      headlines: []
    };
  }
}

module.exports = SentimentService;
