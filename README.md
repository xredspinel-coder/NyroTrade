# NyroTrade

NyroTrade is a production-oriented Node.js Telegram bot for crypto market monitoring and paper trading. It watches Binance spot USDT markets, discovers volatile/meme-style assets, scores momentum and volume spikes, checks news sentiment, and manages a virtual Firestore-backed portfolio across five strategy agents.

NyroTrade is paper trading only. It never submits real exchange trades.

## Features

- Webhook-only Telegram bot using `node-telegram-bot-api`
- Binance spot market data through `ccxt`
- Firestore persistence for settings, portfolio, positions, trades, alerts, watchlists, cooldowns, rankings, sentiment history, and last prices
- Volatile scanner for high momentum, unusual volume, volatility score, liquidity, spread, market age, blacklist, and optional market cap filtering
- Paper strategy engine for WaveHunter, MomentumPulse, WhaleShadow, SentinelMind, and DegenSniper
- DegenSniper high-risk opportunity scoring for acceleration, volume expansion, liquidity, narrative strength, whale activity, social velocity, volatility expansion, and continuation probability
- WhaleShadow whale credibility scoring with wallet/cluster profitability proxies, repeated success/failure tracking, exchange-wallet filtering, market-maker filtering, accumulation/distribution scoring, and copy-worthy wallet score
- Telegram `/control` panel with reports, stats, strategy pages, budgets, risk mode, manual paper buys, force paper sells, pause, and resume
- Paper exits with adaptive stops, intelligent trailing exits, momentum decay, bearish sentiment, volume collapse, partial DegenSniper profit taking, and volatility rank collapse handling
- Central in-memory market cache with cleanup and shared ticker/OHLCV access
- Retry helper with timeout, backoff, and graceful network failure handling
- Structured logs with `INFO`, `WARN`, `ERROR`, `TRADE`, `SIGNAL`, and `SYSTEM`
- `GET /health` endpoint for Render/Railway checks
- Restart-safe scheduled jobs using Firestore locks
- Self-ping for hosted free-tier uptime support
- Telegram command menu registration with `setMyCommands`
- ATR/EMA/higher-timeframe trend filters, confirmation candles, fake-breakout rejection, and market-regime-aware sizing
- Performance analytics with win rate, expectancy, drawdown, streaks, symbol stats, and strategy health diagnostics

## Commands

`/start`, `/control`, `/status`, `/report`, `/stats`, `/strategies`, `/watchlist`, `/scanvolatile`, `/topvolatile`, `/trades`, `/portfolio`, `/positions`, `/resetpaper`, `/pause`, `/resume`, `/health`

Use `/resetpaper confirm` to reset the virtual portfolio and paper trade history.

`/control` opens an inline control panel:

- Report
- Stats
- Strategies
- Budgets
- Risk Mode
- Search Coin
- Force Buy
- Force Sell
- Pause
- Resume

The Strategies menu includes WaveHunter, MomentumPulse, WhaleShadow, SentinelMind, and DegenSniper. Each strategy page shows enabled status, budget, cash, equity, open positions, realized PnL, win rate, profit factor, and aggressiveness, with buttons to enable/disable, set budget, set aggressiveness, show trades, and reset the strategy.

## Requirements

- Node.js 22.x
- Firebase project with Firestore enabled
- Telegram bot token from BotFather
- Public HTTPS URL for Telegram webhooks, such as Render or Railway

## Environment

Copy `.env.example` to `.env` locally or set these variables in your host:

```bash
BOT_TOKEN=
TELEGRAM_CHAT_ID=
WEBHOOK_URL=
TELEGRAM_WEBHOOK_SECRET=
PORT=3000

BINANCE_API_KEY=
BINANCE_API_SECRET=

FIREBASE_PROJECT_ID=
FIREBASE_PRIVATE_KEY=
FIREBASE_CLIENT_EMAIL=

OLLAMA_URL=
OLLAMA_MODEL=llama3.1

PAPER_START_BALANCE=100
BASE_SYMBOL=USDT
WATCHLIST=DOGE/USDT,SHIB/USDT,PEPE/USDT,WIF/USDT,BONK/USDT,FLOKI/USDT,TURBO/USDT

MEME_MODE=true
AUTO_DISCOVER_VOLATILE=true
MAX_WATCHLIST_SIZE=15
MIN_QUOTE_VOLUME_USDT=1000000
VOLATILITY_SCAN_INTERVAL_MINUTES=15
MIN_LIQUIDITY_SCORE=0.62
HIGHER_TIMEFRAME=1h

MAX_TRADE_FRACTION=0.10
MAX_OPEN_POSITIONS=4
STOP_LOSS=-0.05
TAKE_PROFIT=0.08
MIN_BUY_PRICE_CHANGE=0.002
MIN_VOLUME_RATIO=1
MAX_PUMP_ALREADY_MOVED=40
ALERT_COOLDOWN_MINUTES=30
GLOBAL_TRADE_COOLDOWN_MINUTES=5
SYMBOL_TRADE_COOLDOWN_MINUTES=15
CONFIRMATION_CANDLES=3
MIN_BULLISH_CONFIRMATION_CANDLES=2
REQUIRE_EMA_TREND=true
REQUIRE_HIGHER_TIMEFRAME_TREND=true
MAX_MEME_EXPOSURE_PCT=0.40
TRAILING_STOP_PERCENT=0.035

DEGEN_SNIPER_ENABLED=true
DEGEN_SNIPER_BUDGET=20
DEGEN_SNIPER_MAX_TRADE_FRACTION=0.25
DEGEN_SNIPER_MIN_OPPORTUNITY_SCORE=0.78
DEGEN_SNIPER_MAX_SPREAD=0.006
DEGEN_SNIPER_MIN_VOLUME_ACCELERATION=2.0
DEGEN_SNIPER_MIN_MOMENTUM_ACCELERATION=0.015
DEGEN_SNIPER_PARTIAL_TAKE_PROFIT=true
DEGEN_SNIPER_TRAILING_STOP=0.06

MANUAL_TRADING_ENABLED=true
MANUAL_TRADE_MAX_AMOUNT=20
MANUAL_TRADE_CONFIRMATION_REQUIRED=true

WHALE_CREDIBILITY_MIN_SCORE=0.70
WHALE_TRACKING_ENABLED=true
WHALE_EXCHANGE_WALLET_FILTER=true
WHALE_MARKET_MAKER_FILTER=true

SELF_PING=true
SELF_PING_MINUTES=5
ANALYTICS_REFRESH_MINUTES=15
REGIME_REFRESH_MINUTES=5
AI_RANKING_ENABLED=false
```

`WEBHOOK_URL` should be the public base URL only, for example `https://nyrotrade.onrender.com`. The app registers the Telegram endpoint at `/telegram/webhook`.

`BINANCE_API_KEY` and `BINANCE_API_SECRET` are optional for public market data. NyroTrade does not need trading permissions.

## Paper Allocation

Total paper balance is 100 USDT. Strategy allocation is split evenly:

- WaveHunter: 20 USDT
- MomentumPulse: 20 USDT
- WhaleShadow: 20 USDT
- SentinelMind: 20 USDT
- DegenSniper: 20 USDT

Existing Firestore collections are preserved. On bootstrap, NyroTrade ensures a `strategyPortfolios/degensniper` document and keeps strategy budget metadata aligned with the five-way allocation.

## Manual Paper Trading

Manual trading from `/control` is paper-only:

1. Click Search Coin or Force Buy.
2. Type a symbol such as `DOGE`.
3. Select a matching Binance USDT spot pair.
4. Select the strategy that should execute the paper buy.
5. Select `5 USDT`, `10 USDT`, `25%`, `50%`, or `Custom`.
6. Confirm the action.

Confirmed manual buys create Firestore trade records with `source: manual`, `strategy`, `symbol`, `amount`, `userId`, and `timestamp`. Force Sell lists open paper positions, asks for confirmation, and closes the selected paper position only.

For `FIREBASE_PRIVATE_KEY`, keep the escaped newline form in hosted env vars:

```bash
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

## Firebase Setup

1. Create a Firebase project.
2. Open Firestore Database and create a production or test database.
3. Go to Project Settings, Service Accounts.
4. Generate a new private key.
5. Set these env vars from the downloaded service account JSON:
   - `FIREBASE_PROJECT_ID` from `project_id`
   - `FIREBASE_CLIENT_EMAIL` from `client_email`
   - `FIREBASE_PRIVATE_KEY` from `private_key`
6. Do not commit the service account JSON file.

Firestore collections are created automatically on first startup.

## Migration Notes

This update is backward-compatible with the existing Firestore collections. Existing `portfolio`, `positions`, `trades`, `watchlists`, `cooldowns`, `alerts`, `volatilityRankings`, `sentimentHistory`, and `lastKnownPrices` documents are preserved.

New documents/collections are created automatically:

- `analytics/performance` and `analyticsHistory/*`
- `strategyDiagnostics/current`
- `marketRegime/current`
- `strategyPortfolios/degensniper`
- `strategySettings/degensniper`

No manual migration is required. Copy the new env vars from `.env.example` into your deployed environment.

## Strategy Improvements

NyroTrade now waits for stronger confirmation before paper entries: multiple bullish candles, sustained momentum, breakout confirmation, EMA20/EMA50 trend alignment, higher-timeframe momentum, spread checks, liquidity score, and abnormal one-candle pump rejection.

Volatility scoring now blends ATR percentage, rolling standard deviation, candle range, daily movement, volume expansion, and spread penalty. Exits use confirmation candles, volatility-aware trailing stops, momentum decay, and less-sensitive stop-loss behavior to reduce premature sells.

Portfolio sizing is confidence-, volatility-, ATR-, and market-regime-adjusted. Exposure controls cap meme and category concentration. The `/stats` command and scheduled analytics snapshots track long-term paper performance, including drawdown, expectancy, win rate, profit factor, streaks, symbol quality, and strategy health.

DegenSniper is the highest-risk strategy. It looks for asymmetric short-term opportunities with early momentum acceleration, abnormal volume expansion, acceptable liquidity/spread, whale or social confirmation when available, and no obvious rug/dying-asset pattern. It does not use a fixed take-profit target; exits use trailing logic, momentum decay, volume collapse, whale distribution, volatility collapse, partial profit taking, and emergency reversal handling.

WhaleShadow now imitates only high-credibility whale-like behavior. Its score blends prior WhaleShadow paper outcomes for the symbol, repeated successful/failed entries, exchange-wallet-like flow detection, market-maker-like filtering, accumulation/distribution, wallet clustering, and a copy-worthy wallet score.

AI sentiment/ranking support is prepared but disabled by default. If `AI_RANKING_ENABLED=true` and Ollama is configured, AI can assist filtering weak signals only. It never controls all trading decisions.

## Local Run

```bash
npm install
npm start
```

Check:

```bash
curl http://localhost:3000/health
```

Telegram requires a public HTTPS webhook URL, so local command handling needs a tunnel such as ngrok or Cloudflare Tunnel.

## Render Deployment

1. Push this project to GitHub.
2. Create a new Render Web Service from the repository.
3. Runtime: Node.
4. Build command: `npm install`
5. Start command: `npm start`
6. Add all required environment variables in Render.
7. Set `WEBHOOK_URL` to your Render service URL, for example `https://nyrotrade.onrender.com`.
8. Deploy and open `/health`.

`render.yaml` is included for blueprint-style setup. Secrets still need to be entered in Render.

## Railway Deployment

1. Push this project to GitHub.
2. Create a Railway project from the repository.
3. Add the environment variables.
4. Railway will run `npm install` and `npm start`.
5. Set `WEBHOOK_URL` to the Railway public service URL.
6. Confirm `/health` returns JSON.

## Architecture

```text
src/
  bot/             Telegram webhook adapter
  commands/        Telegram command handlers
  config/          Environment parsing and defaults
  scheduler/       Cron jobs with Firestore locks
  services/        Exchange, scanner, strategy support, health, alerts
  storage/         Firestore persistence layer
  strategies/      Signal scoring and paper strategy logic
  utils/           Cache, retry, logging, formatting, concurrency
logs/              Runtime structured log files
```

## Safety Model

NyroTrade only reads public spot market data and simulates trades inside Firestore. Portfolio cash, positions, and trade history are virtual records. The code does not call `createOrder` or any real Binance execution method. Keep Binance keys read-only if you choose to provide them.

This software is informational and educational. Crypto markets are volatile, and paper results do not imply future performance.
