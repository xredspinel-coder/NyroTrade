'use strict';

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, safeNumber(value, min)));
}

function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(safeNumber(value) * factor) / factor;
}

function money(value, symbol = 'USDT') {
  return `${round(value, 4).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  })} ${symbol}`;
}

function percent(value, decimals = 2) {
  return `${round(safeNumber(value) * 100, decimals)}%`;
}

function percentFromWhole(value, decimals = 2) {
  return `${round(safeNumber(value), decimals)}%`;
}

function sanitizeId(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 120);
}

function uniqueSymbols(symbols) {
  return Array.from(new Set((symbols || [])
    .map((symbol) => String(symbol || '').trim().toUpperCase())
    .filter((symbol) => symbol.includes('/'))));
}

function chunkText(text, maxLength) {
  const value = String(text || '');
  if (value.length <= maxLength) return [value];

  const chunks = [];
  let cursor = 0;
  while (cursor < value.length) {
    const next = value.slice(cursor, cursor + maxLength);
    const splitAt = next.lastIndexOf('\n');
    const length = splitAt > maxLength * 0.5 ? splitAt : next.length;
    chunks.push(value.slice(cursor, cursor + length));
    cursor += length;
  }
  return chunks;
}

function isoNow() {
  return new Date().toISOString();
}

function toMillis(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function duration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${total % 60}s`;
}

module.exports = {
  clamp,
  chunkText,
  duration,
  isoNow,
  money,
  percent,
  percentFromWhole,
  round,
  safeNumber,
  sanitizeId,
  sleep,
  toMillis,
  uniqueSymbols
};
