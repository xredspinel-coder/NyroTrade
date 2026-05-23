'use strict';

const { start } = require('./src');

start().catch((error) => {
  const details = error && error.stack ? error.stack : error;
  console.error(JSON.stringify({
    level: 'ERROR',
    system: 'NyroTrade',
    message: 'Fatal startup failure',
    error: details,
    timestamp: new Date().toISOString()
  }));
  process.exitCode = 1;
});
