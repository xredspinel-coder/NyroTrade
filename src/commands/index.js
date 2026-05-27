'use strict';

const { clamp, duration, money, percent, round, toMillis } = require('../utils/format');
const { STRATEGIES, getStrategy, getStrategyName } = require('../strategies/registry');

const chatSessions = new Map();

function timestamp(value) {
  const ms = toMillis(value);
  return ms ? new Date(ms).toISOString() : 'n/a';
}

function formatTopVolatile(items) {
  if (!items || items.length === 0) return 'No volatility rankings yet.';
  return items.map((item, index) => {
    return `${index + 1}. ${item.symbol} | score ${round(item.rankScore, 3)} | ATR ${percent(item.atrPercent || 0)} | momentum ${percent(item.priceChange)} | volume ${round(item.volumeRatio, 2)}x`;
  }).join('\n');
}

function formatTrades(trades, baseSymbol) {
  if (!trades || trades.length === 0) return 'No paper trades yet.';
  return trades.map((trade) => {
    const pnl = trade.pnl !== undefined ? ` | PnL ${money(trade.pnl, baseSymbol)} (${percent(trade.pnlPct || 0)})` : '';
    const label = trade.strategyKey && trade.strategyKey !== 'legacy' ? ` [${trade.strategyKey}]` : '';
    return `${trade.side}${label} ${trade.symbol} @ ${round(trade.price, 8)} | ${money(trade.notional, baseSymbol)}${pnl} | ${timestamp(trade.executedAt)}`;
  }).join('\n');
}

function formatCooldowns(cooldowns) {
  if (!cooldowns || cooldowns.length === 0) return 'No active cooldowns.';
  return cooldowns.slice(0, 8).map((cooldown) => {
    const expiresAt = timestamp(cooldown.expiresAt);
    return `${cooldown.key || cooldown.id} until ${expiresAt}`;
  }).join('\n');
}

function formatStrategyComparison(analytics, baseSymbol) {
  const rows = (analytics && analytics.strategies) || [];
  if (!rows.length) return 'No strategy stats yet.';
  const nameByKey = STRATEGIES.reduce((acc, s) => {
    acc[s.key] = s.name;
    return acc;
  }, {});
  return rows.map((row) => {
    const name = nameByKey[row.strategyKey] || row.strategyKey;
    const pnl = money(row.totalRealizedPnl || 0, baseSymbol);
    return `${name}: ${pnl} | win ${percent(row.winRate || 0)} | PF ${round(row.profitFactor || 0, 2)} | DD ${percent(row.maxDrawdown || 0)}`;
  }).join('\n');
}

function keyboard(rows) {
  return {
    reply_markup: {
      inline_keyboard: rows
    }
  };
}

function strategyMenuButtons(callbackPrefix) {
  return STRATEGIES.map((strategy) => [{
    text: strategy.name,
    callback_data: `${callbackPrefix}:${strategy.key}`
  }]);
}

function getSession(chatId) {
  return chatSessions.get(String(chatId)) || {};
}

function setSession(chatId, patch) {
  const key = String(chatId);
  const current = chatSessions.get(key) || {};
  const next = {
    ...current,
    ...patch,
    updatedAt: Date.now()
  };
  chatSessions.set(key, next);
  return next;
}

function clearSession(chatId) {
  chatSessions.delete(String(chatId));
}

function userIdFrom(update) {
  return String((update.from && update.from.id) || 'unknown');
}

function parseAmount(text) {
  const normalized = String(text || '').trim().replace(',', '.').replace(/[^\d.]/g, '');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function strategyEnabled(strategyKey, settings, config) {
  if (strategyKey === 'degensniper' && !config.degenSniper.enabled) return false;
  return !settings.paused;
}

async function sendControlPanel({ telegram, chatId }) {
  await telegram.sendMessage('NyroTrade control panel', {
    chatId,
    ...keyboard([
      [
        { text: 'Report', callback_data: 'ctl:report' },
        { text: 'Stats', callback_data: 'ctl:stats' }
      ],
      [
        { text: 'Strategies', callback_data: 'ctl:strategies' },
        { text: 'Budgets', callback_data: 'ctl:budgets' }
      ],
      [
        { text: 'Risk Mode', callback_data: 'ctl:risk' },
        { text: 'Search Coin', callback_data: 'ctl:search' }
      ],
      [
        { text: 'Force Buy', callback_data: 'ctl:forcebuy' },
        { text: 'Force Sell', callback_data: 'ctl:forcesell' }
      ],
      [
        { text: 'Pause', callback_data: 'ctl:pause' },
        { text: 'Resume', callback_data: 'ctl:resume' }
      ]
    ])
  });
}

async function sendReport({ telegram, services, config, chatId }) {
  const { portfolio, scanner, storage, analytics, marketRegime } = services;
  const [snapshot, top, trades, cooldowns, diagnostics, regime, stats] = await Promise.all([
    portfolio.getSnapshot({ strategyKey: 'momentumpulse' }).catch(() => portfolio.getSnapshot()),
    scanner.getTopVolatile(5),
    portfolio.getRecentTrades(5),
    storage.getActiveCooldowns(12),
    storage.getStrategyDiagnostics(),
    marketRegime.getCurrent(),
    analytics.getLatestOrCompute()
  ]);
  await telegram.sendMessage([
    'NyroTrade research report',
    `Market regime: ${regime.regime} | aggressiveness ${percent(regime.aggressiveness)}`,
    `Strategy health: ${percent((diagnostics && diagnostics.strategyHealthScore) || 0)}`,
    `Recent win rate: ${percent((stats && stats.recentWinRate) || 0)}`,
    '',
    'Strategy comparison',
    formatStrategyComparison(stats, config.exchange.baseSymbol),
    '',
    portfolio.formatSnapshot(snapshot),
    `Exposure: meme ${percent((snapshot.exposurePct && snapshot.exposurePct.meme) || 0)} | volatile ${percent((snapshot.exposurePct && snapshot.exposurePct.volatile) || 0)} | core ${percent((snapshot.exposurePct && snapshot.exposurePct.core) || 0)}`,
    '',
    'Top volatile',
    formatTopVolatile(top),
    '',
    'Active cooldowns',
    formatCooldowns(cooldowns),
    '',
    'Recent trades',
    formatTrades(trades, config.exchange.baseSymbol)
  ].join('\n'), { chatId });
}

async function sendStrategiesMenu({ telegram, chatId }) {
  await telegram.sendMessage('Strategies', {
    chatId,
    ...keyboard([
      ...strategyMenuButtons('ctl:strategy'),
      [{ text: 'Back', callback_data: 'ctl:back' }]
    ])
  });
}

async function sendBudgets({ telegram, services, config, chatId }) {
  const rows = await Promise.all(STRATEGIES.map(async (strategy) => {
    const [portfolio, settings] = await Promise.all([
      services.storage.getPortfolio(strategy.key),
      services.storage.getStrategySettings(strategy.key)
    ]);
    const budget = Number(settings.budget || (portfolio && portfolio.startBalance) || 0);
    const cash = Number((portfolio && portfolio.cash) || 0);
    const equity = Number((portfolio && portfolio.equity) || cash);
    return `${strategy.name}: budget ${money(budget, config.exchange.baseSymbol)} | cash ${money(cash, config.exchange.baseSymbol)} | equity ${money(equity, config.exchange.baseSymbol)}`;
  }));
  await telegram.sendMessage([
    'Strategy budgets',
    `Total paper balance: ${money(config.risk.paperStartBalance, config.exchange.baseSymbol)}`,
    ...rows
  ].join('\n'), { chatId });
}

async function sendRiskMode({ telegram, services, config, chatId }) {
  const [settings, regime] = await Promise.all([
    services.storage.getSettings(),
    services.marketRegime.getCurrent().catch(() => null)
  ]);
  const rows = await Promise.all(STRATEGIES.map(async (strategy) => {
    const strategySettings = await services.storage.getStrategySettings(strategy.key);
    return `${strategy.name}: ${strategyEnabled(strategy.key, strategySettings, config) ? 'enabled' : 'disabled'} | aggressiveness ${round(strategySettings.aggressiveness || 0, 2)}`;
  }));
  await telegram.sendMessage([
    'Risk mode',
    `Global mode: ${settings.paused ? 'paused' : 'active'}`,
    `Market regime: ${regime ? regime.regime : 'unknown'}`,
    '',
    ...rows
  ].join('\n'), { chatId });
}

async function sendStrategyPage({ telegram, services, config, chatId, strategyKey }) {
  const strategy = getStrategy(strategyKey);
  if (!strategy) {
    await telegram.sendMessage('Unknown strategy.', { chatId });
    return;
  }

  const [settings, snapshot, stats] = await Promise.all([
    services.storage.getStrategySettings(strategyKey),
    services.portfolio.getSnapshot({ strategyKey }),
    services.storage.getLatestStrategyAnalytics(strategyKey).catch(() => null)
  ]);
  const enabled = strategyEnabled(strategyKey, settings, config);
  const budget = Number(settings.budget || snapshot.startBalance || 0);
  const winRate = stats ? stats.winRate || 0 : 0;
  const profitFactor = stats ? stats.profitFactor || 0 : 0;
  const realizedPnl = stats ? stats.totalRealizedPnl || snapshot.realizedPnl || 0 : snapshot.realizedPnl || 0;
  const toggleText = enabled ? 'Disable' : 'Enable';

  await telegram.sendMessage([
    strategy.name,
    `Status: ${enabled ? 'enabled' : 'disabled'}`,
    `Budget: ${money(budget, config.exchange.baseSymbol)}`,
    `Cash: ${money(snapshot.cash, config.exchange.baseSymbol)}`,
    `Equity: ${money(snapshot.equity, config.exchange.baseSymbol)}`,
    `Open positions: ${snapshot.positions.length}`,
    `Realized PnL: ${money(realizedPnl, config.exchange.baseSymbol)}`,
    `Win rate: ${percent(winRate)}`,
    `Profit factor: ${round(profitFactor, 2)}`,
    `Aggressiveness: ${round(settings.aggressiveness || 0, 2)}`
  ].join('\n'), {
    chatId,
    ...keyboard([
      [{ text: toggleText, callback_data: `ctl:toggle:${strategyKey}` }],
      [
        { text: 'Set Budget', callback_data: `ctl:setbudget:${strategyKey}` },
        { text: 'Set Aggressiveness', callback_data: `ctl:setagg:${strategyKey}` }
      ],
      [
        { text: 'Show Trades', callback_data: `ctl:trades:${strategyKey}` },
        { text: 'Reset Strategy', callback_data: `ctl:reset:${strategyKey}` }
      ],
      [{ text: 'Back', callback_data: 'ctl:strategies' }]
    ])
  });
}

async function beginSymbolSearch({ telegram, chatId, force = false }) {
  setSession(chatId, { flow: 'search-symbol', force });
  await telegram.sendMessage('Type a symbol to search Binance spot markets, for example DOGE.', { chatId });
}

async function showMarketMatches({ telegram, services, chatId, query }) {
  const matches = await services.exchange.searchSpotMarkets(query, 12);
  if (!matches.length) {
    clearSession(chatId);
    await telegram.sendMessage(`No Binance USDT spot matches found for ${query}.`, { chatId });
    return;
  }
  setSession(chatId, {
    flow: 'select-pair',
    matches: matches.map((market) => ({ symbol: market.symbol, base: market.base }))
  });
  await telegram.sendMessage('Select a pair', {
    chatId,
    ...keyboard(matches.map((market, index) => [{
      text: market.symbol,
      callback_data: `ctl:pair:${index}`
    }]).concat([[{ text: 'Cancel', callback_data: 'ctl:cancel' }]]))
  });
}

async function askBuyStrategy({ telegram, chatId, symbol }) {
  setSession(chatId, { flow: 'select-buy-strategy', symbol });
  await telegram.sendMessage(`Which strategy should execute the PAPER BUY for ${symbol}?`, {
    chatId,
    ...keyboard([
      ...strategyMenuButtons('ctl:buystrategy'),
      [{ text: 'Cancel', callback_data: 'ctl:cancel' }]
    ])
  });
}

async function askBuyAmount({ telegram, chatId, strategyKey }) {
  setSession(chatId, { flow: 'select-buy-amount', strategyKey });
  await telegram.sendMessage(`Select amount for ${getStrategyName(strategyKey)}.`, {
    chatId,
    ...keyboard([
      [
        { text: '5 USDT', callback_data: 'ctl:amount:5' },
        { text: '10 USDT', callback_data: 'ctl:amount:10' }
      ],
      [
        { text: '25%', callback_data: 'ctl:amount:pct25' },
        { text: '50%', callback_data: 'ctl:amount:pct50' }
      ],
      [
        { text: 'Custom', callback_data: 'ctl:amount:custom' },
        { text: 'Cancel', callback_data: 'ctl:cancel' }
      ]
    ])
  });
}

async function resolveAmount({ services, config, strategyKey, amountCode }) {
  const snapshot = await services.portfolio.getSnapshot({ strategyKey });
  const cash = Number(snapshot.cash || 0);
  const max = Number(config.manualTrading.maxAmount || cash);
  if (amountCode === 'pct25') return Math.min(max, cash * 0.25);
  if (amountCode === 'pct50') return Math.min(max, cash * 0.5);
  return Math.min(max, Number(amountCode));
}

async function confirmManualBuy({ telegram, services, config, chatId, amount }) {
  const session = getSession(chatId);
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    await telegram.sendMessage('Invalid amount. Try Search Coin again.', { chatId });
    clearSession(chatId);
    return;
  }
  const max = Number(config.manualTrading.maxAmount || value);
  if (value > max) {
    await telegram.sendMessage(`Manual trade amount is capped at ${money(max, config.exchange.baseSymbol)}.`, { chatId });
    return;
  }
  const snapshot = await services.portfolio.getSnapshot({ strategyKey: session.strategyKey });
  if (value > Number(snapshot.cash || 0)) {
    await telegram.sendMessage(`Insufficient paper cash. Available: ${money(snapshot.cash, config.exchange.baseSymbol)}.`, { chatId });
    clearSession(chatId);
    return;
  }

  setSession(chatId, { flow: 'confirm-buy', amount: value });
  if (!config.manualTrading.confirmationRequired) {
    await executeManualBuy({ telegram, services, config, chatId, userId: session.userId || 'unknown' });
    return;
  }

  await telegram.sendMessage([
    'Confirm PAPER BUY',
    `Symbol: ${session.symbol}`,
    `Strategy: ${getStrategyName(session.strategyKey)}`,
    `Amount: ${money(value, config.exchange.baseSymbol)}`
  ].join('\n'), {
    chatId,
    ...keyboard([
      [
        { text: 'Confirm', callback_data: 'ctl:confirmbuy' },
        { text: 'Cancel', callback_data: 'ctl:cancel' }
      ]
    ])
  });
}

async function executeManualBuy({ telegram, services, config, chatId, userId }) {
  if (!config.manualTrading.enabled) {
    await telegram.sendMessage('Manual paper trading is disabled.', { chatId });
    clearSession(chatId);
    return;
  }

  const session = getSession(chatId);
  const { symbol, strategyKey, amount } = session;
  if (!symbol || !strategyKey || !amount) {
    await telegram.sendMessage('Manual buy session expired. Start again from Search Coin.', { chatId });
    clearSession(chatId);
    return;
  }

  const [metrics, symbolSentiment, marketRegime] = await Promise.all([
    services.analyzer.analyzeSymbol(symbol),
    services.sentiment.getSentiment(symbol),
    services.marketRegime.getCurrent().catch(() => null)
  ]);
  const result = await services.portfolio.openPosition({
    strategyKey,
    symbol,
    metrics,
    sentiment: symbolSentiment,
    confidence: 1,
    reason: 'manual paper buy from Telegram control panel',
    marketRegime,
    notionalOverride: amount,
    source: 'manual',
    userId
  });
  clearSession(chatId);

  if (!result.executed) {
    await telegram.sendMessage(`PAPER BUY rejected: ${result.reason}`, { chatId });
    return;
  }

  await services.alerts.sendTradeAlert({
    strategyKey,
    side: 'BUY',
    symbol,
    price: metrics.price,
    quantity: result.position.quantity,
    notional: result.position.notional,
    reason: 'manual paper buy'
  });
  await telegram.sendMessage([
    'PAPER BUY created',
    `Symbol: ${symbol}`,
    `Strategy: ${getStrategyName(strategyKey)}`,
    `Amount: ${money(result.position.notional, config.exchange.baseSymbol)}`,
    `Trade id: ${result.tradeId}`
  ].join('\n'), { chatId });
}

async function beginForceSell({ telegram, services, config, chatId }) {
  const positions = await services.storage.getOpenPositions();
  if (!positions.length) {
    clearSession(chatId);
    await telegram.sendMessage('No open paper positions to force sell.', { chatId });
    return;
  }
  setSession(chatId, {
    flow: 'select-sell-position',
    sellPositions: positions.map((position) => ({
      symbol: position.symbol,
      strategyKey: position.strategyKey || 'legacy',
      quantity: position.quantity,
      notional: position.notional
    }))
  });
  await telegram.sendMessage('Select an open PAPER position to close.', {
    chatId,
    ...keyboard(positions.slice(0, 20).map((position, index) => [{
      text: `${getStrategyName(position.strategyKey)} ${position.symbol} ${money(position.notional, config.exchange.baseSymbol)}`,
      callback_data: `ctl:sellpos:${index}`
    }]).concat([[{ text: 'Cancel', callback_data: 'ctl:cancel' }]]))
  });
}

async function confirmForceSell({ telegram, config, chatId, index }) {
  const session = getSession(chatId);
  const position = session.sellPositions && session.sellPositions[Number(index)];
  if (!position) {
    clearSession(chatId);
    await telegram.sendMessage('Position selection expired.', { chatId });
    return;
  }
  setSession(chatId, {
    flow: 'confirm-sell',
    sellIndex: Number(index)
  });
  await telegram.sendMessage([
    'Confirm PAPER SELL',
    `Symbol: ${position.symbol}`,
    `Strategy: ${getStrategyName(position.strategyKey)}`,
    `Notional: ${money(position.notional, config.exchange.baseSymbol)}`
  ].join('\n'), {
    chatId,
    ...keyboard([
      [
        { text: 'Confirm', callback_data: 'ctl:confirmsell' },
        { text: 'Cancel', callback_data: 'ctl:cancel' }
      ]
    ])
  });
}

async function executeForceSell({ telegram, services, config, chatId, userId }) {
  const session = getSession(chatId);
  const position = session.sellPositions && session.sellPositions[session.sellIndex];
  if (!position) {
    clearSession(chatId);
    await telegram.sendMessage('Force sell session expired.', { chatId });
    return;
  }
  const [metrics, symbolSentiment] = await Promise.all([
    services.analyzer.analyzeSymbol(position.symbol),
    services.sentiment.getSentiment(position.symbol)
  ]);
  const result = await services.portfolio.closePosition({
    strategyKey: position.strategyKey,
    symbol: position.symbol,
    price: metrics.price,
    metrics,
    sentiment: symbolSentiment,
    reason: 'manual force sell from Telegram control panel',
    source: 'manual',
    userId
  });
  clearSession(chatId);

  if (!result.executed) {
    await telegram.sendMessage(`PAPER SELL rejected: ${result.reason}`, { chatId });
    return;
  }

  await services.alerts.sendTradeAlert({
    strategyKey: position.strategyKey,
    side: 'SELL',
    symbol: position.symbol,
    price: metrics.price,
    quantity: result.position.quantity,
    notional: result.position.quantity * metrics.price,
    pnl: result.position.realizedPnl,
    pnlPct: result.position.realizedPnlPct,
    reason: 'manual force sell'
  });
  await telegram.sendMessage([
    'PAPER SELL created',
    `Symbol: ${position.symbol}`,
    `Strategy: ${getStrategyName(position.strategyKey)}`,
    `PnL: ${money(result.position.realizedPnl, config.exchange.baseSymbol)} (${percent(result.position.realizedPnlPct)})`,
    `Trade id: ${result.tradeId}`
  ].join('\n'), { chatId });
}

async function handleSessionText({ msg, text, telegram, services, config }) {
  const chatId = msg.chat && msg.chat.id;
  const session = getSession(chatId);
  if (!session.flow) return false;

  if (session.flow === 'search-symbol') {
    await showMarketMatches({ telegram, services, chatId, query: text });
    return true;
  }

  if (session.flow === 'custom-amount') {
    const amount = parseAmount(text);
    await confirmManualBuy({ telegram, services, config, chatId, amount });
    return true;
  }

  if (session.flow === 'set-budget') {
    const value = parseAmount(text);
    if (!value || value <= 0) {
      await telegram.sendMessage('Budget must be a positive USDT amount.', { chatId });
      return true;
    }
    await services.storage.setStrategyBudget(session.strategyKey, value);
    clearSession(chatId);
    await telegram.sendMessage(`${getStrategyName(session.strategyKey)} budget updated to ${money(value, config.exchange.baseSymbol)}.`, { chatId });
    await sendStrategyPage({ telegram, services, config, chatId, strategyKey: session.strategyKey });
    return true;
  }

  if (session.flow === 'set-aggressiveness') {
    const value = parseAmount(text);
    if (value === null || value < 0 || value > 1) {
      await telegram.sendMessage('Aggressiveness must be between 0 and 1.', { chatId });
      return true;
    }
    await services.storage.updateStrategySettings(session.strategyKey, {
      aggressiveness: clamp(value, 0, 1)
    });
    clearSession(chatId);
    await telegram.sendMessage(`${getStrategyName(session.strategyKey)} aggressiveness updated to ${round(value, 2)}.`, { chatId });
    await sendStrategyPage({ telegram, services, config, chatId, strategyKey: session.strategyKey });
    return true;
  }

  return false;
}

async function handleControlCallback({ query, telegram, services, config, logger }) {
  const data = String(query.data || '');
  if (!data.startsWith('ctl:')) return false;

  const chatId = query.message && query.message.chat && query.message.chat.id;
  const userId = userIdFrom(query);
  const [, action, arg] = data.split(':');
  setSession(chatId, { userId });

  try {
    await telegram.bot.answerCallbackQuery(query.id);
  } catch (error) {
    logger.warn('Failed to answer Telegram callback', { error });
  }

  switch (action) {
    case 'back':
      clearSession(chatId);
      await sendControlPanel({ telegram, chatId });
      return true;
    case 'cancel':
      clearSession(chatId);
      await telegram.sendMessage('Cancelled.', { chatId });
      return true;
    case 'report':
      await sendReport({ telegram, services, config, chatId });
      return true;
    case 'stats': {
      const stats = await services.analytics.refresh();
      await telegram.sendMessage(services.analytics.formatStats(stats), { chatId });
      return true;
    }
    case 'strategies':
      await sendStrategiesMenu({ telegram, chatId });
      return true;
    case 'budgets':
      await sendBudgets({ telegram, services, config, chatId });
      return true;
    case 'risk':
      await sendRiskMode({ telegram, services, config, chatId });
      return true;
    case 'search':
    case 'forcebuy':
      await beginSymbolSearch({ telegram, chatId, force: action === 'forcebuy' });
      return true;
    case 'forcesell':
      await beginForceSell({ telegram, services, config, chatId });
      return true;
    case 'pause':
      await services.storage.setPaused(true);
      await telegram.sendMessage('NyroTrade paused. Monitoring continues, but new paper entries are disabled.', { chatId });
      return true;
    case 'resume':
      await services.storage.setPaused(false);
      await telegram.sendMessage('NyroTrade resumed. Strategy entries are enabled.', { chatId });
      await services.strategy.runOnce({ source: 'telegram-control-resume' });
      return true;
    case 'strategy':
      await sendStrategyPage({ telegram, services, config, chatId, strategyKey: arg });
      return true;
    case 'toggle': {
      const settings = await services.storage.getStrategySettings(arg);
      await services.storage.updateStrategySettings(arg, { paused: !settings.paused });
      await sendStrategyPage({ telegram, services, config, chatId, strategyKey: arg });
      return true;
    }
    case 'setbudget':
      setSession(chatId, { flow: 'set-budget', strategyKey: arg });
      await telegram.sendMessage(`Type the new budget in ${config.exchange.baseSymbol} for ${getStrategyName(arg)}.`, { chatId });
      return true;
    case 'setagg':
      setSession(chatId, { flow: 'set-aggressiveness', strategyKey: arg });
      await telegram.sendMessage(`Type aggressiveness from 0 to 1 for ${getStrategyName(arg)}.`, { chatId });
      return true;
    case 'trades': {
      const trades = await services.storage.getRecentTrades(10, arg);
      await telegram.sendMessage(`${getStrategyName(arg)} recent trades\n${formatTrades(trades, config.exchange.baseSymbol)}`, { chatId });
      return true;
    }
    case 'reset':
      await telegram.sendMessage(`Reset ${getStrategyName(arg)} paper portfolio and trades?`, {
        chatId,
        ...keyboard([
          [
            { text: 'Confirm Reset', callback_data: `ctl:resetconfirm:${arg}` },
            { text: 'Cancel', callback_data: 'ctl:cancel' }
          ]
        ])
      });
      return true;
    case 'resetconfirm':
      await services.storage.resetStrategyPaper(arg);
      await telegram.sendMessage(`${getStrategyName(arg)} paper strategy reset.`, { chatId });
      await sendStrategyPage({ telegram, services, config, chatId, strategyKey: arg });
      return true;
    case 'pair': {
      const session = getSession(chatId);
      const match = session.matches && session.matches[Number(arg)];
      if (!match) {
        clearSession(chatId);
        await telegram.sendMessage('Market selection expired.', { chatId });
        return true;
      }
      await askBuyStrategy({ telegram, chatId, symbol: match.symbol });
      return true;
    }
    case 'buystrategy':
      await askBuyAmount({ telegram, chatId, strategyKey: arg });
      return true;
    case 'amount': {
      const session = getSession(chatId);
      if (arg === 'custom') {
        setSession(chatId, { flow: 'custom-amount' });
        await telegram.sendMessage(`Type a custom ${config.exchange.baseSymbol} amount.`, { chatId });
        return true;
      }
      const amount = await resolveAmount({ services, config, strategyKey: session.strategyKey, amountCode: arg });
      await confirmManualBuy({ telegram, services, config, chatId, amount });
      return true;
    }
    case 'confirmbuy':
      await executeManualBuy({ telegram, services, config, chatId, userId });
      return true;
    case 'sellpos':
      await confirmForceSell({ telegram, config, chatId, index: arg });
      return true;
    case 'confirmsell':
      await executeForceSell({ telegram, services, config, chatId, userId });
      return true;
    default:
      return false;
  }
}

function registerCommands({ bot, telegram, services, config, logger }) {
  const {
    portfolio,
    scanner,
    health,
    storage,
    strategy,
    analytics,
    marketRegime
  } = services;

  bot.on('message', async (msg) => {
    const text = String(msg.text || '').trim();
    const chatId = msg.chat && msg.chat.id;
    if (config.telegram.chatId && String(chatId) !== String(config.telegram.chatId)) {
      logger.warn('Ignoring command from unauthorized chat', { chatId });
      return;
    }

    try {
      if (!text.startsWith('/')) {
        await handleSessionText({ msg, text, telegram, services, config });
        return;
      }
    } catch (error) {
      logger.error('Telegram session flow failed', { error });
      await telegram.sendMessage(`Action failed: ${error.message}`, { chatId });
      return;
    }

    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand.split('@')[0].toLowerCase();

    try {
      switch (command) {
        case '/start':
          await telegram.sendMessage([
            'NyroTrade is online.',
            'Paper trading only. Multi-strategy research platform: WaveHunter, MomentumPulse, WhaleShadow, SentinelMind, DegenSniper.',
            '',
            'Commands: /control /status /report /stats /strategies /wave /whales /sentiment /positions /watchlist /topvolatile /trades /pause /resume /resetpaper /health'
          ].join('\n'), { chatId });
          break;

        case '/control':
          await sendControlPanel({ telegram, chatId });
          break;

        case '/status': {
          const [settings, snapshot, watchlist] = await Promise.all([
            storage.getSettings(),
            portfolio.getSnapshot({ strategyKey: 'momentumpulse' }).catch(() => portfolio.getSnapshot()),
            scanner.getWatchlist()
          ]);
          await telegram.sendMessage([
            'NyroTrade status',
            `Mode: ${settings.paused ? 'paused' : 'active'}`,
            `Uptime: ${duration(process.uptime())}`,
            `MomentumPulse equity: ${money(snapshot.equity, config.exchange.baseSymbol)}`,
            `MomentumPulse open: ${snapshot.positions.length}/${config.risk.maxOpenPositions}`,
            `Watchlist: ${watchlist.join(', ')}`
          ].join('\n'), { chatId });
          break;
        }

        case '/report': {
          const [snapshot, top, trades, cooldowns, diagnostics, regime, stats] = await Promise.all([
            portfolio.getSnapshot({ strategyKey: 'momentumpulse' }).catch(() => portfolio.getSnapshot()),
            scanner.getTopVolatile(5),
            portfolio.getRecentTrades(5),
            storage.getActiveCooldowns(12),
            storage.getStrategyDiagnostics(),
            marketRegime.getCurrent(),
            analytics.getLatestOrCompute()
          ]);
          await telegram.sendMessage([
            'NyroTrade research report',
            `Market regime: ${regime.regime} | aggressiveness ${percent(regime.aggressiveness)}`,
            `Strategy health: ${percent((diagnostics && diagnostics.strategyHealthScore) || 0)}`,
            `Recent win rate: ${percent((stats && stats.recentWinRate) || 0)}`,
            '',
            'Strategy comparison',
            formatStrategyComparison(stats, config.exchange.baseSymbol),
            '',
            portfolio.formatSnapshot(snapshot),
            `Exposure: meme ${percent((snapshot.exposurePct && snapshot.exposurePct.meme) || 0)} | volatile ${percent((snapshot.exposurePct && snapshot.exposurePct.volatile) || 0)} | core ${percent((snapshot.exposurePct && snapshot.exposurePct.core) || 0)}`,
            '',
            'Top volatile',
            formatTopVolatile(top),
            '',
            'Active cooldowns',
            formatCooldowns(cooldowns),
            '',
            'Recent trades',
            formatTrades(trades, config.exchange.baseSymbol)
          ].join('\n'), { chatId });
          break;
        }

        case '/stats': {
          const stats = await analytics.refresh();
          await telegram.sendMessage(analytics.formatStats(stats), { chatId });
          break;
        }

        case '/strategies': {
          const stats = await analytics.getLatestOrCompute();
          await telegram.sendMessage([
            'NyroTrade strategies',
            formatStrategyComparison(stats, config.exchange.baseSymbol)
          ].join('\n'), { chatId });
          break;
        }

        case '/wave': {
          const stats = await storage.getLatestStrategyAnalytics('wavehunter').catch(() => null);
          await telegram.sendMessage(stats ? analytics.formatStats(stats) : 'WaveHunter stats not ready yet. Wait for /stats to run.', { chatId });
          break;
        }

        case '/whales': {
          const stats = await storage.getLatestStrategyAnalytics('whaleshadow').catch(() => null);
          await telegram.sendMessage(stats ? analytics.formatStats(stats) : 'WhaleShadow stats not ready yet. Wait for /stats to run.', { chatId });
          break;
        }

        case '/sentiment': {
          const stats = await storage.getLatestStrategyAnalytics('sentinelmind').catch(() => null);
          const market = await storage.getLatestSentiment('MARKET').catch(() => null);
          await telegram.sendMessage([
            stats ? analytics.formatStats(stats) : 'SentinelMind stats not ready yet. Wait for /stats to run.',
            '',
            market
              ? `Market sentiment: ${market.label} score ${round(market.score, 2)} conf ${percent(market.confidence || 0)}`
              : 'Market sentiment: n/a'
          ].join('\n'), { chatId });
          break;
        }

        case '/watchlist': {
          const watchlist = await scanner.getWatchlist();
          await telegram.sendMessage(`Active watchlist\n${watchlist.join('\n')}`, { chatId });
          break;
        }

        case '/scanvolatile': {
          await telegram.sendMessage('Running a volatility scan now...', { chatId });
          const ranked = await scanner.scanVolatile({ force: true, limit: 50 });
          await telegram.sendMessage(`Volatility scan complete\n${formatTopVolatile(ranked.slice(0, 10))}`, { chatId });
          break;
        }

        case '/topvolatile': {
          const top = await scanner.getTopVolatile(10);
          await telegram.sendMessage(`Top volatile markets\n${formatTopVolatile(top)}`, { chatId });
          break;
        }

        case '/trades': {
          const trades = await portfolio.getRecentTrades(10);
          await telegram.sendMessage(`Recent paper trades\n${formatTrades(trades, config.exchange.baseSymbol)}`, { chatId });
          break;
        }

        case '/portfolio': {
          const snapshot = await portfolio.getSnapshot({ strategyKey: 'momentumpulse' }).catch(() => portfolio.getSnapshot());
          await telegram.sendMessage(`MomentumPulse portfolio\n${portfolio.formatSnapshot(snapshot)}`, { chatId });
          break;
        }

        case '/positions': {
          const snapshots = await Promise.all(
            STRATEGIES.map((item) => portfolio.getSnapshot({ strategyKey: item.key }))
          ).catch(() => []);

          if (!snapshots.length) {
            const fallback = await portfolio.getSnapshot();
            await telegram.sendMessage(fallback.positions.length ? portfolio.formatSnapshot(fallback) : 'No open paper positions.', { chatId });
            break;
          }

          const texts = [];
          snapshots.forEach((snap, idx) => {
            texts.push(`${STRATEGIES[idx].name} (${snap.positions.length} open)\n${portfolio.formatSnapshot(snap)}`);
          });
          await telegram.sendMessage(texts.join('\n\n'), { chatId });
          break;
        }

        case '/resetpaper': {
          if (String(args[0] || '').toLowerCase() !== 'confirm') {
            await telegram.sendMessage('To reset the virtual portfolio and paper trade history, send: /resetpaper confirm', { chatId });
            break;
          }
          const snapshot = await portfolio.reset();
          await telegram.sendMessage(`Paper portfolio reset.\n${portfolio.formatSnapshot(snapshot)}`, { chatId });
          break;
        }

        case '/pause':
          await storage.setPaused(true);
          await telegram.sendMessage('NyroTrade paused. Monitoring continues, but new paper entries are disabled.', { chatId });
          break;

        case '/resume':
          await storage.setPaused(false);
          await telegram.sendMessage('NyroTrade resumed. Strategy entries are enabled.', { chatId });
          await strategy.runOnce({ source: 'telegram-resume' });
          break;

        case '/health': {
          const status = await health.getStatus();
          await telegram.sendMessage([
            'NyroTrade health',
            `Status: ${status.status}`,
            `Firestore: ${status.firestore}`,
            `Webhook: ${status.webhook.configured ? 'configured' : 'not configured'}`,
            `Market update: ${status.latestMarketUpdate || 'n/a'}`,
            `Sentiment update: ${status.latestSentimentUpdate || 'n/a'}`,
            `Open positions: ${status.openPositionsCount}`,
            `Strategy health: ${status.strategyHealthScore === null ? 'n/a' : percent(status.strategyHealthScore)}`,
            `Market regime: ${status.marketRegime || 'n/a'}`,
            `Cache: ${JSON.stringify(status.cacheSize)}`
          ].join('\n'), { chatId });
          break;
        }

        default:
          await telegram.sendMessage('Unknown command. Try /control, /status, /report, /stats, /portfolio, /watchlist, /topvolatile, /trades, /pause, /resume, or /health.', { chatId });
      }
    } catch (error) {
      logger.error('Telegram command failed', { command, error });
      await telegram.sendMessage(`Command failed: ${error.message}`, { chatId });
    }
  });

  bot.on('callback_query', async (query) => {
    const chatId = query.message && query.message.chat && query.message.chat.id;
    if (config.telegram.chatId && String(chatId) !== String(config.telegram.chatId)) {
      logger.warn('Ignoring callback from unauthorized chat', { chatId });
      return;
    }

    try {
      const handled = await handleControlCallback({ query, telegram, services, config, logger });
      if (!handled) {
        await telegram.bot.answerCallbackQuery(query.id, { text: 'Unknown action' }).catch(() => undefined);
      }
    } catch (error) {
      logger.error('Telegram callback failed', { data: query.data, error });
      await telegram.sendMessage(`Action failed: ${error.message}`, { chatId });
    }
  });
}

module.exports = {
  registerCommands
};
