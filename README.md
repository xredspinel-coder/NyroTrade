# NyroTrade

Telegram crypto meme/volatile paper trading bot.

## Important

This bot is for education and paper trading only.  
It never places real Binance trades and does not use `createOrder`, `createMarketBuyOrder`, or `createMarketSellOrder`.

## Features

- Telegram webhook mode
- Meme coin and volatile coin scanner
- Binance public market data through `ccxt`
- Paper trading with fake balance
- Hourly reports
- JSON file storage instead of SQLite
- Render/Railway friendly, no `better-sqlite3`

## Commands

- `/start`
- `/status`
- `/report`
- `/watchlist`
- `/setwatchlist DOGE/USDT PEPE/USDT WIF/USDT`
- `/scanvolatile`
- `/topvolatile`
- `/trades`
- `/resetpaper`
- `/pause`
- `/resume`

## Environment Variables

Copy `.env.example` to `.env` locally, or add the same values in Render/Railway variables.

Important:

`WEBHOOK_URL` must be your public app URL only, without `/telegram-webhook`.

Example:

```env
WEBHOOK_URL=https://nyrotrade.onrender.com
```

The script will automatically register:

```text
https://nyrotrade.onrender.com/telegram-webhook
```

## Local Run

```bash
npm install
npm start
```

Then open:

```text
http://localhost:3000/health
```

## Deploy

1. Upload these files to GitHub:
   - `index.js`
   - `package.json`
   - `.env.example`
   - `.gitignore`
   - `README.md`

2. Do not upload:
   - `.env`
   - `node_modules`
   - `nyrotrade-data.json`

3. On Render/Railway, add environment variables.

4. Deploy.

## Recommended Node Version

This project uses Node 22.x.

Avoid Node 26 for now because native packages and hosting environments enjoy making life worse for no clear reason.
