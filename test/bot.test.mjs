import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auc, trainLogistic, learnSymbol, decide } from '../public/js/learn.js';
import { demoChart } from '../public/js/data.js';
import { riskReport, computeSeries } from '../public/js/engine.js';

const dir = mkdtempSync(join(tmpdir(), 'tgbot-'));
process.env.MARKET_DEMO = '1';
process.env.BOT_STATE_FILE = join(dir, 'state.json');
process.env.BOT_CONFIG = join(dir, 'none.json');
process.env.BOT_SYMBOLS = 'AAPL,MSFT,NVDA,TSLA,JPM,BTC-USD,SOL-USD,ETH-USD';
process.env.NTFY_TOPIC = 'tg-test-topic';
process.env.TELEGRAM_BOT_TOKEN = '123:abc'; process.env.TELEGRAM_CHAT_ID = '42';

// capture outbound notifications instead of sending them
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (/ntfy\.sh|api\.telegram\.org/.test(String(url))) { sent.push({ url: String(url), init }); return new Response('{}', { status: 200 }); }
  return realFetch(url, init);
};
const { runBot, trackRecord } = await import('../lib/bot.js');

test('AUC and logistic regression learn a separable problem', () => {
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1]), 0);
  const X = [], y = [];
  for (let i = 0; i < 300; i++) { const a = Math.sin(i) * 2; X.push([a, Math.cos(i * 7)]); y.push(a > 0 ? 1 : 0); }
  const m = trainLogistic(X, y);
  assert.ok(m.predict([2, 0]) > 0.8 && m.predict([-2, 0]) < 0.2);
});

test('learning uses an unseen test window and never calls BUY without evidence', () => {
  const d = demoChart('NVDA', '1d');
  const S = computeSeries(d.candles);
  const L = learnSymbol(d.candles, d.meta, { S });
  assert.ok(L.ok && L.model.testN > 30 && L.model.trainN > 80);
  assert.ok(L.rules.ok ? L.rules.test.from > d.candles[0].t : true);
  const risk = riskReport(d.candles, S, d.meta, null);
  const forced = decide(d.candles, d.meta, { ...L, score: 90, model: { ...L.model, ok: false }, analogs: { n: 0 }, rules: { ...L.rules, ok: false } }, risk);
  assert.notEqual(forced.action, 'BUY');
  assert.equal(decide(d.candles, d.meta, { ...L, score: 90 }, { ...risk, score: 9.5 }).action === 'BUY', false);
});

test('bot run: alerts are delivered, then de-duplicated on the next run', async () => {
  const r1 = await runBot({ classes: ['stock', 'crypto'] });
  assert.equal(r1.scanned, 8);
  const buys1 = r1.sent.filter((s) => s.action === 'BUY');
  for (const s of r1.sent) assert.ok(s.delivered.every((x) => x.ok), JSON.stringify(s.delivered));
  if (buys1.length) {
    const ntfy = sent.find((x) => x.url.includes('ntfy'));
    assert.ok(ntfy && /^[\x20-\x7E]+$/.test(ntfy.init.headers.Title), 'ntfy Title header must be ASCII');
    assert.match(JSON.parse(sent.find((x) => x.url.includes('telegram')).init.body).text, /not financial advice/i);
  }
  const before = sent.length;
  const r2 = await runBot({ classes: ['stock', 'crypto'] });
  assert.equal(r2.sent.filter((s) => s.action === 'BUY').length, 0, 'same BUY must not repeat inside the cooldown');
  assert.equal(sent.length - before, r2.sent.length * 2);
});

test('open paper position exits on trailing stop and is recorded', async () => {
  const st = JSON.parse(readFileSync(process.env.BOT_STATE_FILE, 'utf8'));
  st.symbols.AAPL = { ...(st.symbols.AAPL || {}), open: { entry: 1e9, at: Date.now() - 864e5, stop: 1e9, target: 2e9, t1Hit: false } };
  writeFileSync(process.env.BOT_STATE_FILE, JSON.stringify(st));
  const r = await runBot({ classes: ['stock'] });
  const exit = r.sent.find((s) => s.symbol === 'AAPL' && s.action === 'EXIT');
  assert.ok(exit, 'expected an EXIT alert for AAPL');
  const after = JSON.parse(readFileSync(process.env.BOT_STATE_FILE, 'utf8'));
  assert.ok(!after.symbols.AAPL.open);
  const tr = trackRecord(after);
  assert.ok(tr.closed >= 1 && tr.winRate != null);
});

test('bot API requires the access code', async () => {
  const { handleApi } = await import('../lib/market.js');
  process.env.APP_ACCESS_TOKEN = 'correct-horse-battery';
  assert.equal((await handleApi('/api/bot/status', new URLSearchParams(), { headers: {}, ip: 'b1' })).status, 401);
  const ok = await handleApi('/api/bot/status', new URLSearchParams(), { headers: { authorization: 'Bearer correct-horse-battery' }, ip: 'b2' });
  assert.equal(ok.status, 200);
  const j = JSON.parse(ok.body);
  assert.deepEqual(j.channels.sort(), ['ntfy', 'telegram']);
  assert.ok(j.report && j.alerts.length >= 1);
});

test('alerts and digest are tagged by asset class; crypto uses its own rules', async () => {
  const { loadConfig } = await import('../lib/bot.js');
  const c = loadConfig();
  assert.equal(c.classRules.crypto.riskPct, 0.5);
  assert.ok(c.classRules.crypto.maxRisk > c.classRules.stock.maxRisk);
  const st = JSON.parse(readFileSync(process.env.BOT_STATE_FILE, 'utf8'));
  for (const a of st.alerts.filter((x) => x.action !== 'DIGEST')) assert.match(a.title, /· (STOCK|ETF|CRYPTO)/);
  const dec = st.lastReport.decisions;
  assert.ok(dec.every((d) => ['stock', 'etf', 'crypto'].includes(d.assetClass)));
  assert.ok(dec.some((d) => d.assetClass === 'crypto') || st.lastReport.classes.length === 1);
});
