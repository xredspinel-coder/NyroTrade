'use strict';

const express = require('express');

function createServer({ telegram, health }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/', (req, res) => {
    res.json({
      name: 'NyroTrade',
      status: 'running',
      paperTradingOnly: true
    });
  });

  app.get('/health', async (req, res) => {
    try {
      const status = await health.getStatus();
      res.status(status.firestore === 'ok' ? 200 : 503).json(status);
    } catch (error) {
      res.status(503).json({
        status: 'error',
        error: error.message
      });
    }
  });

  app.post('/telegram/webhook', (req, res) => telegram.handleWebhook(req, res));

  return app;
}

module.exports = {
  createServer
};
