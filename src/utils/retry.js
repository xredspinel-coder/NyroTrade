'use strict';

const { sleep } = require('./format');

function isRetryable(error) {
  if (!error) return false;
  const status = error.response && error.response.status;
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  if (status >= 500) return true;
  const code = String(error.code || '').toUpperCase();
  return [
    'ECONNRESET',
    'ECONNABORTED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'NETWORK_ERROR'
  ].includes(code);
}

function timeoutError(label, timeoutMs) {
  const error = new Error(`${label || 'operation'} timed out after ${timeoutMs}ms`);
  error.code = 'ETIMEDOUT';
  return error;
}

async function withTimeout(task, timeoutMs, label) {
  if (!timeoutMs || timeoutMs <= 0) return task();

  let timeoutId;
  try {
    return await Promise.race([
      task(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(timeoutError(label, timeoutMs)), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function withRetry(task, options = {}) {
  const {
    retries = 3,
    baseDelayMs = 500,
    maxDelayMs = 8000,
    timeoutMs = 15000,
    label = 'operation',
    logger,
    shouldRetry = isRetryable
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await withTimeout(() => task(attempt), timeoutMs, label);
    } catch (error) {
      lastError = error;
      const retryable = attempt < retries && shouldRetry(error);
      if (!retryable) break;

      const jitter = Math.floor(Math.random() * baseDelayMs);
      const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt)) + jitter;
      if (logger) {
        logger.warn('Retrying failed operation', {
          label,
          attempt: attempt + 1,
          delayMs: delay,
          error
        });
      }
      await sleep(delay);
    }
  }

  throw lastError;
}

module.exports = {
  isRetryable,
  withRetry,
  withTimeout
};
