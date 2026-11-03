# TradeGuide roadmap

Status after v1.6 (global markets + accessibility audit). Ordered by impact.

## Done in v1.6
- 30+ world exchanges: hours, lunch breaks, weekends, currencies, rules, benchmarks, "your time" conversion
- Worldwide search (any format: `VOD.L`, `LSE:VOD`, `700 HK`), 180+ most-traded global companies always searchable, EODHD-powered full global search when keyed
- International data chain (EODHD → Twelve Data → Yahoo → Stooq), FX to USD (open.er-api → ECB → fallback)
- Local-currency pricing (pence/cents), USD-equivalent risk & liquidity, position sizing across currencies
- World market clock, World scanner, bot scans international stocks during their own sessions
- Self-hosted fonts (Google Fonts is blocked in mainland China), WCAG AA contrast, keyboard-focusable tables, larger touch targets — 0 axe violations

## Next — highest impact
1. **Paid global data feed** — EODHD "All World" or Twelve Data Pro. Free sources are rate-limited on cloud hosts; this is the single biggest reliability upgrade for non-US markets.
2. **User accounts** — today one access code unlocks one owner's broker data. Real multi-user needs sign-in (passkeys/OAuth), per-user SnapTrade users, a database (Postgres/Supabase) and per-user encryption of tokens.
3. **Fundamentals & events** — earnings dates (the #1 cause of stop-skipping gaps), P/E, revenue growth, dividends, splits, analyst estimates.
4. **News & sentiment** — headlines per symbol, with sentiment feeding the signal.
5. **Price & signal alerts set by the user** — "tell me if VOD.L closes above 80p" via Web Push, Telegram or email.
6. **Translations (i18n)** — Chinese (Simplified/Traditional), Spanish, French, Portuguese, Hindi, Arabic (RTL). Number/date/currency formats already follow the browser's locale.
7. **Paper trading** — simulate following the signals with a virtual account before risking money.

## Platform & operations
- Custom domain + CDN (Cloudflare) — faster worldwide; `*.onrender.com` can be slow or blocked in some countries (e.g. mainland China needs an ICP-licensed host/CDN to be reliable)
- Always-on hosting (Render Starter) so live trades and the bot never sleep
- Persistent store for the bot and caches (Upstash/Postgres) instead of memory/files
- CI: run `npm test` on every push (GitHub Actions); Dependabot for dependency updates
- Error monitoring (Sentry) and uptime checks on `/api/health`
- Server-side rate limiting per user, audit log for broker access

## Product depth
- Options chains and Greeks; futures; forex pairs
- Fully customizable backtests (choose indicators, thresholds, costs, slippage) and walk-forward reports
- Chart drawing tools, multi-timeframe view, comparison overlays
- Portfolio analytics: sector/country/currency exposure, correlation matrix, historical performance vs benchmark
- Tax-lot view and realized P/L (from SnapTrade activities)

## Legal & compliance (before charging users)
- **Market-data licensing**: redistributing exchange prices to the public usually requires the data vendor's redistribution licence — check your provider's terms
- Terms of service, privacy policy (GDPR/CCPA), cookie notice
- Clear "not investment advice" positioning; avoid personalised recommendations unless registered as an adviser where required
