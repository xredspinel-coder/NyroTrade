'use strict';

const fs = require('fs');
const path = require('path');
const { isoNow } = require('./format');

const LOG_DIR = path.resolve(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'nyrotrade.log');
const LEVELS = new Set(['INFO', 'WARN', 'ERROR', 'TRADE', 'SIGNAL', 'SYSTEM']);

function serializeError(error) {
  if (!error) return undefined;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return error;
}

class Logger {
  constructor() {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  log(level, message, meta = {}) {
    const normalizedLevel = LEVELS.has(level) ? level : 'INFO';
    const payload = {
      timestamp: isoNow(),
      level: normalizedLevel,
      message,
      ...meta
    };

    if (payload.error) {
      payload.error = serializeError(payload.error);
    }

    const line = JSON.stringify(payload);
    const output = normalizedLevel === 'ERROR' ? console.error : console.log;
    output(line);

    fs.promises.appendFile(LOG_FILE, `${line}\n`).catch(() => {
      // Console logging is the durable path on hosted platforms.
    });
  }

  info(message, meta) {
    this.log('INFO', message, meta);
  }

  warn(message, meta) {
    this.log('WARN', message, meta);
  }

  error(message, meta) {
    this.log('ERROR', message, meta);
  }

  trade(message, meta) {
    this.log('TRADE', message, meta);
  }

  signal(message, meta) {
    this.log('SIGNAL', message, meta);
  }

  system(message, meta) {
    this.log('SYSTEM', message, meta);
  }
}

module.exports = new Logger();
