// TradeGuide Bot — scans, learns each symbol's history, decides, and NOTIFIES. It never places orders.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getChart, discover } from './market.js';
import { portfolio as brokerPortfolio, status as brokerStatus } from './brokers.js';
import { notify, configuredChannels } from './notify.js';
import { getStore } from './store.js';
import { learnAndDecide } from '../public/js/learn.js';
import { fmtPx, pctS } from '../public/js/engine.js';
import { classify, PROFILES } from '../public/js/assets.js';

const env = (k) => (process.env[k] || '').trim();

export const DEFAULT_CONFIG = {
  interval: '1d',
  universe: {
    stocks: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AMD', 'AVGO', 'JPM', 'V', 'NFLX', 'COST', 'PLTR', 'COIN', 'SPY', 'QQQ'],
    crypto: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'BNB-USD', 'ADA-USD', 'DOGE-USD', 'AVAX-USD', 'LINK-USD', 'LTC-USD'],
  },
  discover: true,          // also scan Yahoo's most-active stocks each run
  discoverCount: 15,
  includeHoldings: true,   // scan what you own (needs a broker connection) and send SELL alerts for holdings
  minEvidence: 2,          // of 3: model, history analogs, out-of-sample back-test
  maxRisk: 8,              // skip BUY alerts above this risk score
  cooldownHours: 72,       // don't repeat the same alert for a symbol within this window
  account: 10000, riskPct: 1,
  // Different markets, different rules. Crypto is normally 2–3× as volatile as stocks, so it gets a
  // higher risk ceiling (or no crypto would ever qualify) but HALF the position risk and wider stops.
  classRules: {
    stock: { maxRisk: 7, riskPct: 1, minEvidence: 2 },
    etf: { maxRisk: 7, riskPct: 1, minEvidence: 2 },
    crypto: { maxRisk: 9, riskPct: 0.5, minEvidence: 2 },
  },
  notify: { buy: true, sell: true, exits: true, watch: false, digest: true, digestHourET: 17 },
};

export function loadConfig() {
  let file = {};
  const p = resolve(env('BOT_CONFIG') || './bot.config.json');
  try { file = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`bot.config.json: ${e.message}`); }
  const cr = file.classRules || {};
  const c = { ...DEFAULT_CONFIG, ...file, universe: { ...DEFAULT_CONFIG.universe, ...(file.universe || {}) }, notify: { ...DEFAULT_CONFIG.notify, ...(file.notify || {}) },
    classRules: Object.fromEntries(Object.entries(DEFAULT_CONFIG.classRules).map(([k, v]) => [k, { ...v, ...(cr[k] || {}) }])) };
  if (env('BOT_SYMBOLS')) {
    const syms = env('BOT_SYMBOLS').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    c.universe = { stocks: syms.filter((s) => !/-USD$/.test(s)), crypto: syms.filter((s) => /-USD$/.test(s)) };
  }
  if (env('BOT_ACCOUNT')) c.account = +env('BOT_ACCOUNT');
  if (env('BOT_RISK_PCT')) { c.riskPct = +env('BOT_RISK_PCT'); c.classRules.stock.riskPct = c.classRules.etf.riskPct = c.riskPct; }
  if (env('BOT_CRYPTO_RISK_PCT')) c.classRules.crypto.riskPct = +env('BOT_CRYPTO_RISK_PCT');
  if (env('BOT_MAX_RISK')) { c.maxRisk = +env('BOT_MAX_RISK'); c.classRules.stock.maxRisk = c.classRules.etf.maxRisk = c.maxRisk; }
  if (env('BOT_CRYPTO_MAX_RISK')) c.classRules.crypto.maxRisk = +env('BOT_CRYPTO_MAX_RISK');
  if (env('BOT_MIN_EVIDENCE')) { c.minEvidence = +env('BOT_MIN_EVIDENCE'); Object.values(c.classRules).forEach((r) => (r.minEvidence = c.minEvidence)); }
  return c;
}

// ---------- Market clock (US equities, America/New_York) ----------
export function etParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { wd: p.weekday, h: +p.hour % 24, m: +p.minute, day: `${p.year}-${p.month}-${p.day}` };
}
export function stocksWindowOpen(d = new Date()) {
  const { wd, h, m } = etParts(d);
  if (wd === 'Sat' || wd === 'Sun') return false;
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 45 && mins <= 16 * 60 + 20; // from 15 min after open to 20 min after close
}

// ---------- Run ----------
let running = false;
export const isRunning = () => running;

export async function runBot(opts = {}) {
  if (running) return { skipped: 'A scan is already running' };
  running = true;
  const t0 = Date.now();
  const cfg = loadConfig();
  const store = getStore();
  const appUrl = env('APP_URL').replace(/\/$/, '');
  const link = (s) => (appUrl ? `${appUrl}/#/${encodeURIComponent(s)}` : '');
  const classes = opts.classes || (stocksWindowOpen() || env('BOT_STOCKS_ALWAYS') === '1' ? ['stock', 'crypto'] : ['crypto']);
  try {
    const state = await store.load();
    const report = { at: Date.now(), classes, scanned: 0, errors: [], decisions: [], sent: [], store: store.kind, dryRun: !!opts.dryRun };

    // 1) Universe
    const set = new Map();
    const add = (s, src) => { s = String(s || '').toUpperCase(); if (s && !set.has(s)) set.set(s, src); };
    if (classes.includes('stock')) cfg.universe.stocks.forEach((s) => add(s, 'list'));
    if (classes.includes('crypto')) cfg.universe.crypto.forEach((s) => add(s, 'list'));
    if (cfg.discover && classes.includes('stock')) {
      try { (await discover(cfg.discoverCount)).forEach((s) => add(s, 'discover')); } catch (e) { report.errors.push({ symbol: '(discover)', error: e.message }); }
    }
    const held = new Map();
    if (cfg.includeHoldings && brokerStatus().some((p) => p.configured && p.id !== 'demo')) {
      try {
        const pf = await brokerPortfolio();
        for (const p of pf.positions) if (p.chartSymbol && p.qty > 0) {
          const isCrypto = /-USD$/.test(p.chartSymbol);
          if (classes.includes(isCrypto ? 'crypto' : 'stock')) { add(p.chartSymbol, 'holding'); held.set(p.chartSymbol, (held.get(p.chartSymbol) || 0) + p.qty); }
        }
      } catch (e) { report.errors.push({ symbol: '(portfolio)', error: e.message }); }
    }
    // keep scanning symbols where the bot has an open paper position
    for (const [s, st] of Object.entries(state.symbols)) if (st.open) {
      const isCrypto = /-USD$/.test(s);
      if (classes.includes(isCrypto ? 'crypto' : 'stock')) add(s, 'open');
    }

    // 2) Learn + decide (concurrency 3)
    const benches = {};
    const bench = (ac) => { const b = ac === 'crypto' ? 'BTC-USD' : 'SPY'; return (benches[b] ||= getChart(b, cfg.interval).then((d) => d.candles).catch(() => null)); };
    const queue = [...set.keys()];
    const results = [];
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (queue.length) {
        const sym = queue.shift();
        try {
          const d = await getChart(sym, cfg.interval);
          const meta = { ...d.meta, interval: cfg.interval };
          const b = meta.symbol === (meta.assetClass === 'crypto' ? 'BTC-USD' : 'SPY') ? null : await bench(meta.assetClass);
          const C = classify(meta.symbol, meta.assetClass, meta.name);
          const r = learnAndDecide(d.candles, meta, b, { ...cfg, ...cfg.classRules[C.cls] });
          results.push({ sym, meta, C, ...r, source: set.get(sym) });
        } catch (e) { report.errors.push({ symbol: sym, error: e.message }); }
      }
    }));
    report.scanned = results.length;

    // 3) Act on decisions
    const now = Date.now();
    const cool = cfg.cooldownHours * 3600e3;
    const outbox = [];
    const recentlySent = (st, key) => st.sent?.[key] && now - st.sent[key] < cool;
    const mark = (st, key) => { st.sent = { ...(st.sent || {}), [key]: now }; };

    for (const r of results.sort((a, b) => (b.decision.score ?? 0) - (a.decision.score ?? 0))) {
      const { sym, meta, decision: D, learned: L, risk, C } = r;
      const rules = cfg.classRules[C.cls];
      const tag = C.cryptoLinked ? `${C.profile.short} · ₿-linked` : C.profile.short;
      const mkt = C.cls === 'crypto' ? 'Crypto market · open 24/7' : 'US stock market';
      const st = (state.symbols[sym] ||= {});
      const atr = L.S?.atr.at(-1) || 0;
      const price = D.price ?? L.S?.c.at(-1);
      st.last = { action: D.action, score: D.score, price, at: now, pUp: L.model?.pUp ?? null, auc: L.model?.auc ?? null, risk: risk.score };
      report.decisions.push({
        symbol: sym, name: meta.name, assetClass: C.cls, cryptoLinked: C.cryptoLinked, source: r.source, held: held.has(sym), action: D.action, score: D.score, buyLine: D.buyLine, sellLine: D.sellLine, price,
        pUp: L.model?.pUp ?? null, auc: L.model?.auc ?? null, analogsP: L.analogs?.pUp ?? null, analogsN: L.analogs?.n ?? 0, analogsMean: L.analogs?.mean ?? null,
        oosRet: L.rules?.ok ? L.rules.test.ret : null, oosBh: L.rules?.ok ? L.rules.test.bh : null, oosTrades: L.rules?.ok ? L.rules.test.trades : 0,
        risk: risk.score, riskLevel: risk.level, evidence: (D.evidence || []).map((e) => ({ key: e.key, pass: e.pass, bear: e.bear })), reason: D.reason, demo: !!r.meta.demo,
      });
      if (!L.ok || price == null) continue;
      const ev = (D.evidence || []).map((e) => `${e.pass ? '✓' : e.bear ? '✗' : '–'} ${e.label}: ${e.text}`).join('\n');
      const footer = 'Educational signal, not financial advice. Confirm before trading.';

      // a) Manage the bot's open paper position (exit alerts)
      if (st.open) {
        const o = st.open;
        o.stop = Math.max(o.stop, price - 3 * atr);
        let exit = null;
        if (price <= o.stop) exit = 'trailing stop hit';
        else if (D.action === 'SELL') exit = `sell signal (${D.reason})`;
        if (!exit && !o.t1Hit && price >= o.target) {
          o.t1Hit = true; o.stop = Math.max(o.stop, o.entry);
          if (cfg.notify.exits) outbox.push({ sym, action: 'TARGET', title: `🎯 TARGET HIT · ${tag} · ${sym} @ ${fmtPx(price)}`, body: `${sym} reached target 1 (${fmtPx(o.target)}), +${((price / o.entry - 1) * 100).toFixed(1)}% since the BUY alert.\nConsider taking partial profit. Stop moved to break-even ${fmtPx(o.stop)}.\n\n${footer}`, tags: 'dart', priority: '4' });
        }
        if (exit) {
          const ret = price / o.entry - 1;
          state.trades.push({ symbol: sym, entry: o.entry, exit: price, ret, openedAt: o.at, closedAt: now, reason: exit });
          delete st.open;
          if (cfg.notify.exits) outbox.push({ sym, action: 'EXIT', title: `🔴 SELL / EXIT · ${tag} · ${sym} @ ${fmtPx(price)}`, body: `Exit: ${exit}.\nResult since BUY alert at ${fmtPx(o.entry)}: ${pctS(ret)}.\n\n${ev}\n\n${footer}`, tags: 'red_circle', priority: '4' });
          mark(st, 'SELL');
          continue;
        }
      }

      // b) New BUY
      if (D.action === 'BUY' && !st.open && cfg.notify.buy && !recentlySent(st, 'BUY')) {
        const p = D.plan;
        const units = Math.abs(price - p.stop) > 0 ? (cfg.account * rules.riskPct / 100) / Math.abs(price - p.stop) : 0;
        const qty = meta.assetClass === 'crypto' ? units.toFixed(units < 1 ? 5 : 3) : Math.floor(units);
        st.open = { entry: price, at: now, stop: p.stop, target: p.t1, t1Hit: false };
        mark(st, 'BUY');
        outbox.push({
          sym, action: 'BUY', priority: '4', tags: 'green_circle',
          title: `🟢 BUY · ${tag} · ${sym} @ ${fmtPx(price)}`,
          body: `${meta.name || sym} — ${C.profile.label}${C.cryptoLinked ? ` (${C.linkedNote})` : ''} · ${mkt}\nSignal ${D.score >= 0 ? '+' : ''}${D.score.toFixed(0)} (learned buy line ${D.buyLine}) · evidence ${D.evidenceCount}/3 · risk ${risk.score}/10 ${risk.level}\n\n${ev}\n\nPlan: stop ${fmtPx(p.stop)} (${pctS(p.stopPct)}) · target ${fmtPx(p.t1)} (${pctS(p.t1Pct)}) · 2:1 reward/risk\nSize at ${rules.riskPct}% risk (${C.profile.label.toLowerCase()} rule) on $${cfg.account.toLocaleString()}: ~${qty} ${C.cls === 'crypto' ? 'units' : 'shares'}\n${C.cls === 'crypto' ? 'Crypto: trades 24/7 — set the stop on the exchange, not in your head.' : 'Stock: check the earnings date; overnight gaps can skip the stop.'}\n\n${footer}`,
        });
        continue;
      }

      // c) SELL alert for something you actually hold
      if (held.has(sym) && D.action === 'SELL' && cfg.notify.sell && !recentlySent(st, 'SELL')) {
        mark(st, 'SELL');
        outbox.push({ sym, action: 'SELL', priority: '4', tags: 'warning', title: `🔴 SELL · ${tag} · your ${sym} @ ${fmtPx(price)}`, body: `You hold ${held.get(sym)} ${sym}.\n${D.reason}\nRisk ${risk.score}/10. Trailing stop idea: ${fmtPx(price - 3 * atr)}.\n\n${ev}\n\n${footer}` });
        continue;
      }

      // d) Optional watch alerts
      if (D.action === 'WATCH' && cfg.notify.watch && !recentlySent(st, 'WATCH')) {
        mark(st, 'WATCH');
        outbox.push({ sym, action: 'WATCH', priority: '2', tags: 'eyes', title: `👀 WATCH · ${tag} · ${sym} @ ${fmtPx(price)}`, body: `${D.reason}\n\n${ev}\n\n${footer}` });
      }
    }

    // 4) Daily digest
    const et = etParts();
    if (cfg.notify.digest && et.h >= cfg.notify.digestHourET && state.lastDigestDay !== et.day && results.length) {
      state.lastDigestDay = et.day;
      outbox.push({ sym: '(digest)', action: 'DIGEST', priority: '2', tags: 'newspaper', title: `📊 TradeGuide daily digest — ${et.day}`, body: digest(report, state) });
    }

    // 5) Send
    for (const m of outbox) {
      const msg = { ...m, url: m.sym.startsWith('(') ? appUrl : link(m.sym), data: { symbol: m.sym, action: m.action } };
      const delivered = opts.dryRun ? [{ channel: 'dry-run', ok: true }] : await notify(msg);
      report.sent.push({ symbol: m.sym, action: m.action, title: m.title, delivered });
      state.alerts.unshift({ at: now, symbol: m.sym, action: m.action, title: m.title, body: m.body, delivered });
    }
    state.alerts = state.alerts.slice(0, 300);
    state.trades = state.trades.slice(-500);
    state.lastRun = now;
    report.ms = Date.now() - t0;
    state.lastReport = report;
    if (!opts.noSave) await store.save(state);
    return report;
  } finally { running = false; }
}

export function trackRecord(state) {
  const T = state.trades || [];
  const wins = T.filter((t) => t.ret > 0);
  const open = Object.entries(state.symbols || {}).filter(([, s]) => s.open).map(([sym, s]) => ({ symbol: sym, ...s.open, last: s.last?.price, unrealised: s.last?.price ? s.last.price / s.open.entry - 1 : null }));
  const sub = (f) => { const t = T.filter(f), w = t.filter((x) => x.ret > 0); return { closed: t.length, winRate: t.length ? w.length / t.length : null, avgRet: t.length ? t.reduce((a, x) => a + x.ret, 0) / t.length : null }; };
  const isC = (t) => classify(t.symbol).cls === 'crypto';
  return {
    byClass: { stock: sub((t) => !isC(t)), crypto: sub(isC) },
    closed: T.length, winRate: T.length ? wins.length / T.length : null,
    avgRet: T.length ? T.reduce((a, t) => a + t.ret, 0) / T.length : null,
    total: T.reduce((a, t) => a * (1 + t.ret), 1) - 1, open,
  };
}

function digest(report, state) {
  const D = report.decisions;
  const tr = trackRecord(state);
  const lines = [`Scanned ${report.scanned} symbols.`];
  for (const [key, label] of [['stocks', '🏛 STOCKS & ETFs'], ['crypto', '🪙 CRYPTO']]) {
    const mine = D.filter((d) => (d.assetClass === 'crypto') === (key === 'crypto'));
    if (!mine.length) continue;
    const top = mine.filter((d) => d.action === 'BUY' || d.action === 'WATCH').sort((a, b) => b.score - a.score).slice(0, 4);
    const sells = mine.filter((d) => d.action === 'SELL' && d.held);
    const buys = mine.filter((d) => d.action === 'BUY').length, bear = mine.filter((d) => d.action === 'SELL').length;
    lines.push(`\n${label} — ${mine.length} scanned · ${buys} buy · ${bear} sell`);
    lines.push(top.length ? top.map((d) => `• ${d.symbol}${d.cryptoLinked ? ' (₿-linked)' : ''} ${d.action} — score ${d.score.toFixed(0)}, risk ${d.risk}/10${d.pUp != null ? `, P(up) ${(d.pUp * 100).toFixed(0)}%` : ''}`).join('\n') : '• No setups passed the evidence checks.');
    if (sells.length) lines.push('Sell signals on your holdings: ' + sells.map((d) => d.symbol).join(', '));
    const rc = tr.byClass[key === 'crypto' ? 'crypto' : 'stock'];
    if (rc.closed) lines.push(`Bot record here: ${rc.closed} closed, ${(rc.winRate * 100).toFixed(0)}% winners, avg ${pctS(rc.avgRet)}`);
  }
  if (tr.open.length) lines.push('\nOpen bot alerts:\n' + tr.open.map((o) => `• ${o.symbol} from ${fmtPx(o.entry)} → ${pctS(o.unrealised)}`).join('\n'));
  lines.push(`\nOverall bot record: ${tr.closed} closed alerts${tr.closed ? `, ${(tr.winRate * 100).toFixed(0)}% winners, avg ${pctS(tr.avgRet)}` : ''}.`);
  lines.push('\nEducational signals, not financial advice.');
  return lines.join('\n');
}

export async function botStatus() {
  const store = getStore();
  const state = await store.load();
  const cfg = loadConfig();
  return {
    channels: configuredChannels(), store: store.kind, running, lastRun: state.lastRun, schedulerOn: env('BOT_ENABLED') === '1',
    stocksWindowOpen: stocksWindowOpen(), config: { classRules: cfg.classRules, minEvidence: cfg.minEvidence, maxRisk: cfg.maxRisk, cooldownHours: cfg.cooldownHours, universe: cfg.universe.stocks.length + cfg.universe.crypto.length, discover: cfg.discover, includeHoldings: cfg.includeHoldings, notify: cfg.notify },
    report: state.lastReport, alerts: state.alerts.slice(0, 60), trades: state.trades.slice(-100).reverse(), record: trackRecord(state),
  };
}

export async function sendTest() {
  const ch = configuredChannels();
  if (!ch.length) { const e = new Error('No notification channel configured. Set TELEGRAM_*, NTFY_TOPIC, DISCORD_WEBHOOK_URL, RESEND_* or ALERT_WEBHOOK_URL.'); e.status = 400; throw e; }
  return notify({ title: '✅ TradeGuide test alert', body: `Notifications are working on: ${ch.join(', ')}.\nYou will get BUY / SELL / EXIT alerts and a daily digest here.`, url: env('APP_URL'), tags: 'white_check_mark' });
}

// ---------- Scheduler (Node server or `npm run bot -- --loop`) ----------
export function startScheduler({ intervalMin = +(env('BOT_INTERVAL_MIN') || 60), log = console.log } = {}) {
  const tick = async () => {
    try {
      const r = await runBot();
      if (r.skipped) return log(`[bot] ${r.skipped}`);
      log(`[bot] ${new Date().toISOString()} scanned ${r.scanned} (${r.classes.join('+')}) in ${r.ms}ms, sent ${r.sent.length} alert(s)${r.errors.length ? `, ${r.errors.length} error(s)` : ''}`);
    } catch (e) { log(`[bot] run failed: ${e.message}`); }
  };
  setTimeout(tick, 5_000);
  const h = setInterval(tick, Math.max(15, intervalMin) * 60_000);
  log(`[bot] scheduler on — every ${Math.max(15, intervalMin)} min; stocks during US market hours, crypto 24/7; channels: ${configuredChannels().join(', ') || 'NONE (alerts only stored)'}`);
  return () => clearInterval(h);
}
