# TradeGuide v1.4 — Stock & Crypto Signals, Risk, Portfolio, Live Trades & Alert Bot

Installable PWA that analyses any stock, ETF or coin and tells you:

- **Signal** — Strong Buy / Buy / Hold / Sell / Strong Sell from a −100…+100 composite of 7 technical factors (trend + ADX, MACD, RSI, 20-bar breakout, Bollinger %B, Stochastic, Volume/OBV), with a plain-English reason for every factor and a confidence score.
- **Risk score 1–10** — volatility, max drawdown, VaR/CVaR, beta (vs SPY or BTC), ATR, liquidity, penny-stock and crypto penalties — plus written risk warnings.
- **Trade plan** — entry, ATR/swing stop-loss, 2R/3R targets, trailing stop, resistance check, and position sizing from your account size and risk %.
- **Back-test of the signal on that exact chart** — strategy vs buy-and-hold, win rate, profit factor, drawdown, equity curve, trade log. (Inspired by TradingView/TrendSpider back-testing; the point is to show when the signal *doesn't* work.)
- **Portfolio** — connects (read-only) to your brokerage and shows every position with quantity, cost, value, P/L, weight, TradeGuide signal, risk, trailing stop and a suggested action, plus portfolio-level alerts (sell signals on holdings, big losers, concentration, crypto share, overall risk). Tap any holding to see a **Your position** card on its analysis.
- **Live trades (read-only)** — connects to Robinhood, Webull, Schwab, Fidelity, E*TRADE, IBKR, Vanguard, Public, tastytrade, Coinbase, Kraken, Alpaca and more, and streams your orders and fills into the app as they happen, with a pop-up + phone alert and an instant TradeGuide check (*"⚠️ this buy goes against the current Sell signal"*).
- **Alert bot** — scans your list (plus Yahoo's most-active stocks and your own holdings) on a schedule, **learns each asset's own history**, decides, and pushes BUY / SELL / EXIT / TARGET alerts and a daily digest to Telegram, ntfy, Discord, email or any webhook. Never places trades. Every alert is paper-tracked so you can see the bot's real hit rate.
- **"What this asset's history says"** card on every analysis — the same learning engine, live in the browser.
- **Stocks vs crypto, treated as different markets** — every asset is tagged STOCK / ETF / CRYPTO (plus ₿-LINKED for COIN, MSTR, miners and bitcoin ETFs). Live market status (NYSE hours, pre/after-hours, weekends, holidays and early closes vs crypto's 24/7), volatility judged against its own class, class-specific risk warnings, stop width (2× vs 2.5× ATR) and suggested position risk (1% vs 0.5%), a side-by-side "Stock vs crypto" profile card, separate stock/crypto market panels in the scanner, a stocks-vs-crypto split of your portfolio, and bot rules, alerts, digest and track record split by class.
- **Scanner** for 17 large stocks/ETFs and 10 major coins, **watchlist** with signal-flip highlighting, 1H / 1D / 1W timeframes, Learn page.

No API keys needed for market data. Data: Yahoo Finance chart API → fallback Binance.US (crypto) / Stooq (stocks), proxied server-side with caching, input validation and rate limiting. If no API is reachable (e.g. opened as plain static files) the app switches to clearly bannered **DEMO** synthetic data.

## Run locally
```bash
npm install                 # one dependency: SnapTrade SDK (only loaded if SnapTrade is configured)
cp .env.example .env        # fill in APP_ACCESS_TOKEN + broker keys
npm run start:env           # Node 20.6+ → http://localhost:8787   (or: node server.js without broker keys)
npm test                    # 32 tests incl. mock broker WebSockets, signed webhooks and an end-to-end live stream
```

## Connect your brokerage (read-only)
1. **Set your access code.** Generate one and set it as `APP_ACCESS_TOKEN` on your host:
   `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`
   Without it, all broker endpoints are switched off. Wrong codes are rate-limited (8 tries → 15-minute lockout).
2. **Pick a connector** and add its keys as environment variables (Netlify → Site settings → Environment variables; Vercel → Project → Settings → Environment Variables):

| Your broker | Connector | Env vars |
|---|---|---|
| Schwab, Fidelity, Robinhood, Webull, E*TRADE, Vanguard, Interactive Brokers, Public, Coinbase, Kraken and more | **SnapTrade** (dashboard.snaptrade.com) | `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY` (+ `SNAPTRADE_USER_ID`, `SNAPTRADE_USER_SECRET` for commercial keys — create with `npm run setup:snaptrade`) |
| Alpaca | **Alpaca** API keys | `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`, `ALPACA_PAPER=true/false` |

3. Set `APP_URL` to your https URL, redeploy, open **Portfolio**, enter your access code.
4. SnapTrade: press **Connect brokerage**, sign in to your broker on SnapTrade's secure page (TradeGuide never sees your broker password), then press **Refresh**. Connections are requested as `read` only.

Security model: broker keys exist only in server env vars; the browser only holds your access code (session-only unless you tick "Remember"); broker responses are `no-store`; account numbers are masked; there are no order/trade endpoints in the code. To test the UI without a broker set `BROKER_DEMO=1`, or click *Preview with a sample portfolio*.

## Live trades — connect Robinhood, Webull and more (read-only)

### What's possible, broker by broker (researched Nov 2026)
| Broker | Official route used | How fast your trades show up |
|---|---|---|
| **Webull** | SnapTrade (official Webull partner) | Trade-detection webhook: ~5 s to 25 min (your choice of plan) |
| **Robinhood — stocks & options** | SnapTrade. Robinhood has **no** public stock API | Trade detection every 5 min+; or recent-orders poll |
| **Robinhood — crypto** | Robinhood **Crypto Trading API** (official, Ed25519 keys) | Poll every 20 s |
| **Schwab, E*TRADE** | SnapTrade | Trade detection every 5 min+ |
| **tastytrade, Alpaca (via SnapTrade), Moomoo** | SnapTrade | Trade detection down to ~5 s |
| **Fidelity, Vanguard, IBKR, Public, Merrill, SoFi, Kraken, …** | SnapTrade | Recent-orders poll (realtime endpoint), holdings daily/on refresh |
| **Alpaca** | Direct WebSocket `trade_updates` | **Instant** (push) |
| **Coinbase** | Direct Advanced Trade WebSocket `user` channel (CDP key) | **Instant** (push) |

Deliberately **not** used: unofficial Robinhood/Webull libraries that log in with your broker password. They violate broker terms, break without warning and can get the account locked. Every connection here is official, revocable and **read-only** — TradeGuide has no code path that places, changes or cancels an order (a test enforces this).

### Setup
1. **Access code** — `APP_ACCESS_TOKEN` (see above). Everything broker-related is off without it.
2. **SnapTrade** (Robinhood, Webull, Schwab, Fidelity, …)
   - Create keys at **dashboard.snaptrade.com** → set `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY` (+ user id/secret for commercial keys: `npm run setup:snaptrade`).
   - In the app: **Portfolio → Connect a brokerage** → tap Robinhood / Webull / … → sign in on SnapTrade's secure page. Connections are requested read-only.
   - **Real-time fills**: dashboard → **Webhooks** → add `https://YOUR-APP/api/webhooks/snaptrade`. Then dashboard → **Add-ons → Trade detection** for each account. SnapTrade bills this per account per month by speed (5 s ≈ $100, 25 s ≈ $25, 100 s ≈ $7.50, 5 min ≈ $2.50, 15 min ≈ $0.83). Robinhood, Schwab and E*TRADE support 5 min or slower; Webull and tastytrade support all speeds. Detection runs on weekdays ~9:00–16:30 ET.
   - Without the add-on TradeGuide polls SnapTrade's realtime recent-orders endpoint every `SNAPTRADE_POLL_MIN` (10 — SnapTrade's guidance is ≤ 1 poll / 10 min / account).
   - Webhooks are verified (HMAC-SHA256 of the canonical JSON with your consumer key, 5-minute replay window, duplicate-id rejection).
3. **Robinhood crypto (direct)** — robinhood.com/account/crypto → **Add key**, grant read permissions only → `ROBINHOOD_API_KEY`, `ROBINHOOD_PRIVATE_KEY` (base64 Ed25519 private key).
4. **Coinbase (direct, instant)** — portal.cdp.coinbase.com → API key with **View** permission only → `COINBASE_API_KEY_NAME` (`organizations/…/apiKeys/…`) and `COINBASE_API_PRIVATE_KEY`.
5. **Alpaca (direct, instant)** — `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`, `ALPACA_PAPER`.

### Where it runs
The live hub keeps WebSockets open and pushes to your browser with Server-Sent Events, so it needs a **long-running Node host** (Render, Railway, Fly.io, a VPS, or your PC). It starts automatically when a broker and the access code are set. On **Netlify/Vercel** the webhook receiver and fill alerts still work, and the app falls back to refreshing orders every 30 s.

Every fill can also go to your phone (`LIVE_NOTIFY=1`, uses the bot's Telegram/ntfy/Discord/email channels) with TradeGuide's check of that trade.

## Alert bot

### How it decides (per symbol, every run)
1. **Signal** — the same 7-factor score as the app.
2. **Learns that asset's own history** (`public/js/learn.js`) with three independent checks:
   - **Model** — logistic regression on 11 indicator features predicting "higher in 10 bars". Trained on the oldest 70% of history, scored on the newest 30% it never saw (with a purge gap so overlapping windows can't leak). Trusted only if its unseen-data AUC ≥ 0.54.
   - **History analogs** — every past day this asset had a similar score: how often did it rise, and by how much on average?
   - **Tuned rules** — 36 combinations of buy line / sell line / stop width tuned on the old data, then judged *only* on the unseen data.
3. **Decision** — **BUY** only if the score is above the asset's *learned* buy line **and** ≥ 2 of 3 checks agree **and** risk ≤ your limit. **SELL** when the score drops below the learned sell line or 2 checks turn bearish. Otherwise **WATCH** (bullish but unproven) or **HOLD**.
4. **After a BUY alert** the bot paper-tracks it: trailing stop (3×ATR), a **TARGET** alert at 2R (stop moves to break-even), and an **EXIT** alert on the stop or a sell signal. SELL alerts also fire for anything you actually hold (when a broker is connected). The same alert won't repeat within 72 h.

### Get alerts on your phone (one or more)
| Channel | Setup |
|---|---|
| **Telegram** (recommended) | Message **@BotFather** → `/newbot` → copy the token → send your new bot any message → open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. |
| **ntfy** (no account) | Install the ntfy app and subscribe to a long random topic (e.g. `tg-7f3k9q2x`). Set `NTFY_TOPIC`. Topics are public by name, so make it unguessable. |
| Discord | Channel → Integrations → Webhooks → copy URL → `DISCORD_WEBHOOK_URL` |
| Email | Resend.com API key → `RESEND_API_KEY`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` |
| Anything else | `ALERT_WEBHOOK_URL` (JSON POST — Zapier, Make, IFTTT, Slack) |

Check delivery with `npm run bot:test` or **Bot → Send test alert**.

### Run it (pick one)
| Where | How | Bot memory |
|---|---|---|
| **Always-on host** (Render, Railway, Fly, VPS) | `BOT_ENABLED=1` — runs inside the web server every `BOT_INTERVAL_MIN` (60) | `data/bot-state.json` (use a persistent disk) |
| **GitHub Actions** (free) | Push the repo and add secrets — `.github/workflows/bot.yml` runs every 30 min in market hours and every 2 h for crypto | committed back to the repo, or Upstash |
| Your computer | `npm run bot:loop` | `data/bot-state.json` |
| Netlify / Vercel | Host the app there; run the bot with GitHub Actions and set the same `UPSTASH_REDIS_REST_*` on both so the **Bot** tab can read it | Upstash Redis (free tier) |

Stocks are scanned 9:45–16:20 ET on weekdays; crypto 24/7. Commands: `npm run bot` (one scan) · `npm run bot:dry` (decide without sending, everything) · `npm run bot:loop` · `npm run bot:test`. Try it offline: `MARKET_DEMO=1 npm run bot:dry`.

Tune `bot.config.json`: symbols, `discover`, `includeHoldings`, `classRules` (stocks/ETFs: max risk 7, 1% per trade · crypto: max risk 9, 0.5% per trade), `cooldownHours` (72), account/risk sizing, and which alert types to send (`watch` is off by default to keep noise down).

### Honest expectations
Markets are mostly noise. On many assets the model's unseen-data AUC lands near 0.50 — no better than chance — and the bot correctly refuses to act on it. Expect few BUY alerts; quiet days mean the bot is doing its job. Judge it by the paper track record in the **Bot** tab over months, not by a handful of alerts.

## Deploy
| Host | How |
|---|---|
| **Netlify** | Drag the folder / connect repo. `netlify.toml` publishes `public/` and routes `/api/*` to `netlify/functions/api.mjs`. |
| **Vercel** | Import repo. `vercel.json` serves `public/`; `api/*.js` are the functions. |
| **VPS / Render / Railway / Fly** | `npm start` (uses `PORT`). Put behind HTTPS for the service worker. |

Security headers (CSP, nosniff, frame-deny, referrer, permissions) ship on all three targets. Everything user-specific (watchlist, account size) stays in the browser's localStorage.

## Structure
```
public/            PWA (index.html, styles.css, sw.js, manifest, icons)
public/js/indicators.js   SMA/EMA/RSI/MACD/Bollinger/ATR/ADX/Stochastic/OBV
public/js/engine.js       signal scoring, risk, trade plan, back-test (pure, shared with tests)
public/js/assets.js       asset classes: profiles, crypto-linked list, class volatility, NYSE market clock
public/js/learn.js        per-asset learning (model, analogs, walk-forward rules) + decision engine
public/js/data.js         API client + demo-data fallback + scan universe
public/js/app.js          UI (analysis, scanner, portfolio, watchlist)
lib/market.js      server data layer (Yahoo → Binance.US / Stooq), cache, validation, API router
lib/brokers.js     read-only connectors (SnapTrade, Alpaca, Coinbase, Robinhood Crypto, demo), order normalizer, access-code gate
lib/live.js        live trade hub: WebSocket streams, pollers, SnapTrade webhooks, SSE, fill alerts + trade check
lib/keys.js        signing: Coinbase ES256/EdDSA JWT, Robinhood Ed25519, SnapTrade webhook HMAC, SSE tickets
scripts/           snaptrade-setup.mjs (one-time user registration for commercial keys)
lib/bot.js         alert bot: universe, learn+decide, paper tracking, cooldowns, digest, scheduler
lib/notify.js      Telegram / ntfy / Discord / email / webhook
lib/store.js       bot memory: JSON file or Upstash Redis
bot/run.mjs        bot CLI · bot.config.json · .github/workflows/bot.yml
server.js          Node server · netlify/ · api/ (Vercel)
test/              node:test suite
```

## Tuning
- Factor weights and label thresholds: `scoreAt()` / `labelFor()` in `engine.js`.
- Risk score formula: `riskReport()`. Stop/target multiples: `tradePlan()`.
- Scan universe: `UNIVERSE` in `data.js`.

## Important
Technical signals describe past price behaviour; they do not predict the future. Yahoo's endpoint is unofficial and can change or rate-limit — for a commercial launch, swap `lib/market.js` to a licensed feed (Polygon, Finnhub, Twelve Data, Alpaca). TradeGuide is educational, not financial advice; get legal review of the disclaimer before charging users.
