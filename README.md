# Crypto AI Telegram Paper Trading Bot MVP

Educational Telegram bot for crypto market monitoring, headline sentiment, simulated paper trading, and hourly progress reports.

## Important Warning

This project is for education and experimentation only. It never places real trades and does not promise profit. Crypto markets are risky and volatile. Treat all output as informational, not financial advice.

## Features

- Telegram commands: `/start`, `/status`, `/watchlist`, `/setwatchlist`, `/report`, `/trades`, `/resetpaper`, `/pause`, `/resume`
- Binance public market data through `ccxt`
- SQLite storage for prices, sentiment, alerts, positions, trades, and settings
- Rule-based sentiment fallback, with optional Ollama-compatible endpoint
- Simulated paper trading only, starting from `PAPER_START_BALANCE`
- 5 minute market checks, 30 minute news/sentiment checks, and hourly reports
- Express health endpoints for Railway

## Environment Variables

Copy `.env.example` to `.env` locally or add these variables in Railway:

```bash
BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id
PORT=3000
BINANCE_API_KEY=
BINANCE_API_SECRET=
OLLAMA_URL=
PAPER_START_BALANCE=100
BASE_SYMBOL=USDT
WATCHLIST=BTC/USDT,ETH/USDT,SOL/USDT,WIF/USDT
```

`BINANCE_API_KEY` and `BINANCE_API_SECRET` are optional and are not required. The bot never submits real orders.

## Local Run

```bash
npm install
npm start
```

Open `http://localhost:3000/health` to verify the server is running.

## Telegram Setup

1. Create a bot with [BotFather](https://t.me/BotFather).
2. Copy the bot token into `BOT_TOKEN`.
3. Send a message to your bot.
4. Get your chat ID from a trusted Telegram get-id bot or by temporarily logging inbound messages.
5. Set `TELEGRAM_CHAT_ID`.

## Railway Deployment

1. Push this folder to a GitHub repository.
2. Create a new Railway project from that repository.
3. Add the environment variables in Railway.
4. Railway will run `npm install` and `npm start`.
5. Confirm `GET /` returns `Bot is running`.
6. Confirm `GET /health` returns JSON status.

Railway free instances can sleep or restart. The bot stores its SQLite database on the container filesystem, which may not be durable across redeploys. For long-term storage, attach a persistent volume or migrate to a hosted database.

## Strategy Rules

The MVP buys a simulated position only when bullish sentiment, positive momentum, and volume confirmation align. It sells when take profit, stop loss, bearish sentiment, or reversal rules trigger. Risk is capped to 20% of fake cash per trade, with a maximum of 3 open positions.

Again: this is paper trading only.
