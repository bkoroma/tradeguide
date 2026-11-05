import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeSeries } from '../public/js/engine.js';
import { findSetups, replay, rankOpportunities } from '../public/js/setups.js';

// Build candles from a close path
const bars = (closes, wig = 0.006) => closes.map((c, i) => ({ t: 1.7e9 + i * 86400, o: i ? closes[i - 1] : c, h: Math.max(c, i ? closes[i - 1] : c) * (1 + wig), l: Math.min(c, i ? closes[i - 1] : c) * (1 - wig), c, v: 1e6 }));
// uptrend for 260 days, then a tight 25-day consolidation just under the high
const trendThenFlag = () => { const a = []; for (let i = 0; i < 260; i++) a.push(50 * Math.exp(i * 0.004) * (1 + 0.03 * Math.sin(i / 6))); const top = a[a.length - 1]; for (let i = 0; i < 25; i++) a.push(top * (0.985 + 0.01 * Math.sin(i / 2))); return a; };

test('breakout watch: detected under the high in an uptrend, with a trigger above the high and a stop below', () => {
  const S = computeSeries(bars(trendThenFlag()));
  const { upcoming } = findSetups(S);
  const b = upcoming.find((x) => x.type === 'breakout');
  assert.ok(b, 'breakout setup expected');
  const hi20 = Math.max(...S.h.slice(-20));
  assert.ok(b.trigger > hi20 && b.trigger < hi20 * 1.02);
  assert.ok(b.stop < S.c.at(-1) && b.stop < b.trigger);
  assert.ok(Math.abs(b.target - (b.trigger + 2 * (b.trigger - b.stop))) < 1e-9);
  assert.ok(b.readiness >= 50 && b.readiness <= 100);
  assert.ok(b.reasons.length >= 2 && b.histText.length > 0);
});

test('no long setups in a downtrend', () => {
  const a = []; for (let i = 0; i < 300; i++) a.push(200 * Math.exp(-i * 0.004) * (1 + 0.02 * Math.sin(i / 5)));
  const { upcoming, triggered } = findSetups(computeSeries(bars(a)));
  assert.equal(upcoming.filter((x) => x.type !== 'oversold_bounce').length, 0);
  assert.equal(triggered.length, 0);
});

test('triggered: a breakout that fired yesterday shows as buy-now, not also as upcoming', () => {
  const a = trendThenFlag(); const top = Math.max(...a.slice(-20));
  a.push(top * 1.015, top * 1.02);
  const { triggered, upcoming } = findSetups(computeSeries(bars(a)));
  const t = triggered.find((x) => x.type === 'breakout');
  assert.ok(t && t.status === 'triggered' && t.barsAgo <= 2);
  assert.ok(!upcoming.some((x) => x.type === 'breakout'));
});

test('history replay counts fills, wins and R without look-ahead or overlap', () => {
  const a = []; for (let k = 0; k < 6; k++) { const base = a.length ? a[a.length - 1] : 50; for (let i = 0; i < 60; i++) a.push(base * Math.exp(i * 0.004)); const top = a[a.length - 1]; for (let i = 0; i < 15; i++) a.push(top * 0.99); }
  const st = replay(computeSeries(bars(a, 0.004)), 'breakout');
  assert.ok(st.seen >= 1 && st.trades <= st.seen);
  if (st.trades) { assert.ok(st.winRate >= 0 && st.winRate <= 1); assert.ok(Number.isFinite(st.avgR) && st.avgR <= 2 && st.avgR >= -3); }
});

test('ranking hides patterns that lost money on that asset and extreme-risk assets', () => {
  const mk = (sym, verdict, risk) => ({ symbol: sym, risk, setups: { triggered: [], upcoming: [{ status: 'upcoming', type: 'breakout', readiness: 80, verdict, rank: 80 }] } });
  const r = rankOpportunities([mk('GOOD', 'strong', 5), mk('BAD', 'negative', 5), mk('WILD', 'strong', 9.5)]);
  assert.deepEqual(r.upcoming.map((x) => x.symbol), ['GOOD']);
  assert.equal(r.filteredOut, 2);
});

test('bot: SETTING UP alert → pending → TRIGGERED alert opens a paper trade tagged with the setup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tgsetup-'));
  Object.assign(process.env, { MARKET_DEMO: '1', BOT_STATE_FILE: join(dir, 's.json'), BOT_CONFIG: join(dir, 'none.json'), BOT_SYMBOLS: 'AAPL,MSFT,NVDA,AMD,PLTR,BTC-USD,SOL-USD,XRP-USD,LINK-USD', NTFY_TOPIC: 'x' });
  const sent = []; globalThis.fetch = async (url, init) => { if (String(url).includes('ntfy')) sent.push(init.headers.Title); return new Response('{}'); };
  const { runBot } = await import('../lib/bot.js');
  const r1 = await runBot({ classes: ['stock', 'crypto'] });
  assert.ok(Array.isArray(r1.ideas));
  // force a pending setup on a symbol and make its trigger already crossed
  const st = JSON.parse(readFileSync(process.env.BOT_STATE_FILE, 'utf8'));
  const sym = 'MSFT'; st.symbols[sym] ||= {}; delete st.symbols[sym].open; st.symbols[sym].sent = {};
  st.symbols[sym].pending = { breakout: { type: 'breakout', label: 'Breakout watch', icon: '🚀', trigger: 1, stop: 0.5, target: 2, riskPct: 0.5, reasons: ['test'], histText: 'test', createdAt: Date.now(), expiresAt: Date.now() + 864e5 } };
  writeFileSync(process.env.BOT_STATE_FILE, JSON.stringify(st));
  const r2 = await runBot({ classes: ['stock'] });
  const trig = r2.sent.find((x) => x.action === 'TRIGGERED' && x.symbol === sym);
  assert.ok(trig, 'expected a TRIGGERED alert');
  assert.match(trig.title, /🔔 TRIGGERED · STOCK · MSFT/);
  const after = JSON.parse(readFileSync(process.env.BOT_STATE_FILE, 'utf8'));
  assert.equal(after.symbols[sym].open.setup, 'breakout');
  assert.ok(!after.symbols[sym].pending.breakout);
  for (const t of sent) assert.ok(/^[\x20-\x7E]*$/.test(t), 'ntfy titles must stay ASCII');
});

test('opportunity board endpoint returns ranked buy-now and upcoming lists', async () => {
  process.env.MARKET_DEMO = '1'; process.env.OPP_SYMBOLS = 'AAPL,NVDA,SPY,BTC-USD,ETH-USD,SOL-USD';
  const { handleApi } = await import('../lib/market.js');
  const r = await handleApi('/api/opportunities', new URLSearchParams());
  assert.equal(r.status, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.scanned, 6);
  for (const x of [...b.buyNow, ...b.upcoming]) { assert.ok(x.trigger > x.stop && x.target > x.trigger); assert.ok(['strong', 'positive', 'unproven'].includes(x.verdict)); }
});
