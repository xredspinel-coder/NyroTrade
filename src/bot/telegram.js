'use strict';

const TelegramBot = require('node-telegram-bot-api');
const { chunkText, sleep } = require('../utils/format');
const { withRetry } = require('../utils/retry');
const { registerCommands } = require('../commands');

const COMMAND_MENU = [
  { command: 'start', description: 'Start NyroTrade and show available actions' },
  { command: 'status', description: 'View bot mode, uptime, equity, and watchlist' },
  { command: 'report', description: 'Get portfolio, exposure, cooldown, and market report' },
  { command: 'stats', description: 'Review performance analytics and strategy health' },
  { command: 'watchlist', description: 'Show the active monitored symbols' },
  { command: 'topvolatile', description: 'Show current volatility rankings' },
  { command: 'positions', description: 'List open paper positions and unrealized PnL' },
  { command: 'trades', description: 'Show recent paper trade history' },
  { command: 'health', description: 'Check webhook, Firestore, cache, and scheduler status' },
  { command: 'pause', description: 'Pause new paper entries while monitoring continues' },
  { command: 'resume', description: 'Resume strategy entries' },
  { command: 'resetpaper', description: 'Reset virtual portfolio after confirmation' }
];

class TelegramService {
  constructor({ config, services, logger }) {
    this.config = config;
    this.logger = logger;
    this.bot = new TelegramBot(config.telegram.token, {
      polling: false
    });
    this.queue = Promise.resolve();
    this.webhookStatus = {
      configured: false,
      url: config.telegram.fullWebhookUrl || null,
      lastSetAt: null,
      error: null
    };

    registerCommands({
      bot: this.bot,
      telegram: this,
      services,
      config,
      logger
    });
  }

  async configureWebhook() {
    if (!this.config.telegram.fullWebhookUrl) {
      this.webhookStatus.error = 'WEBHOOK_URL is not configured';
      this.logger.warn('Telegram webhook URL is missing; webhook was not registered');
      return this.webhookStatus;
    }

    await this.registerCommandMenu();

    const options = {
      allowed_updates: ['message']
    };
    if (this.config.telegram.webhookSecret) {
      options.secret_token = this.config.telegram.webhookSecret;
    }

    await withRetry(
      () => this.bot.setWebHook(this.config.telegram.fullWebhookUrl, options),
      {
        label: 'telegram.setWebhook',
        retries: 3,
        timeoutMs: this.config.telegram.sendTimeoutMs,
        logger: this.logger
      }
    );

    this.webhookStatus = {
      configured: true,
      url: this.config.telegram.fullWebhookUrl,
      lastSetAt: new Date().toISOString(),
      error: null
    };
    this.logger.system('Telegram webhook configured', {
      url: this.config.telegram.fullWebhookUrl
    });
    return this.webhookStatus;
  }

  async registerCommandMenu() {
    await withRetry(
      () => this.bot.setMyCommands(COMMAND_MENU),
      {
        label: 'telegram.setMyCommands',
        retries: 3,
        timeoutMs: this.config.telegram.sendTimeoutMs,
        logger: this.logger
      }
    );
    this.logger.system('Telegram command menu registered', {
      commands: COMMAND_MENU.map((item) => `/${item.command}`)
    });
  }

  handleWebhook(req, res) {
    if (this.config.telegram.webhookSecret) {
      const header = req.get('x-telegram-bot-api-secret-token');
      if (header !== this.config.telegram.webhookSecret) {
        this.logger.warn('Rejected Telegram webhook with invalid secret');
        res.sendStatus(401);
        return;
      }
    }

    try {
      this.bot.processUpdate(req.body);
      res.sendStatus(200);
    } catch (error) {
      this.logger.error('Failed to process Telegram update', { error });
      res.sendStatus(500);
    }
  }

  async sendMessage(text, options = {}) {
    const chatId = options.chatId || this.config.telegram.chatId;
    if (!chatId) {
      this.logger.warn('Telegram chat id missing; message skipped');
      return false;
    }

    this.queue = this.queue
      .catch(() => undefined)
      .then(() => this.sendChunks(chatId, text, options));
    return this.queue;
  }

  async sendChunks(chatId, text, options) {
    const chunks = chunkText(text, this.config.telegram.maxMessageLength);
    for (const chunk of chunks) {
      await withRetry(
        () => this.bot.sendMessage(chatId, chunk, {
          disable_web_page_preview: true
        }),
        {
          label: 'telegram.sendMessage',
          retries: 3,
          timeoutMs: this.config.telegram.sendTimeoutMs,
          logger: this.logger
        }
      );
      if (chunks.length > 1) await sleep(650);
    }
    return true;
  }

  getWebhookStatus() {
    return this.webhookStatus;
  }
}

module.exports = TelegramService;
