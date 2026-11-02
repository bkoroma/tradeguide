import test from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../public/js/indicators.js';
import { analyze, computeSeries, scoreAt, labelFor, maxDrawdown } from '../public/js/engine.js';
import { demoChart } from '../public/js/data.js';
import { validate, handleApi, assetClassOf } from '../lib/market.js';

const mk = (fn, n = 400) => Array.from({ length: n }, (_, i) => { const c = fn(i); return { t: 1.6e9 + i * 86400, o: c * 0.995, h: c * 1.01, l: c * 0.99, c, v: 1e6 + (i % 7) * 1e5 }; });

test('SMA / EMA / RSI basics', () => {
  assert.deepEqual(I.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const e = I.ema([1, 2, 3, 4, 5, 6], 3); assert.equal(e[2], 2); assert.equal(e[3], 3);
  const up = I.rsi(Array.from({ length: 30 }, (_, i) => i + 1)); assert.equal(up.at(-1), 100);
  const r = I.rsi(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 3)); assert.ok(r.at(-1) > 0 && r.at(-1) < 100);
});

test('ATR, ADX, Bollinger, Stochastic produce finite values', () => {
  const S = computeSeries(mk((i) => 100 + i * 0.3 + Math.sin(i / 3) * 4));
  for (const k of ['atr', 'adx', 'pctB', 'stochK', 'stochD', 'macdHist', 'sma200']) assert.ok(Number.isFinite(S[k].at(-1)), k);
});

test('steady uptrend scores bullish, downtrend bearish', () => {
  const upC = mk((i) => 50 * Math.exp(i * 0.003) * (1 + 0.02 * Math.sin(i / 4)));
  const dnC = mk((i) => 200 * Math.exp(-i * 0.003) * (1 + 0.02 * Math.sin(i / 4)));
  const up = scoreAt(computeSeries(upC), upC.length - 1).score;
  const dn = scoreAt(computeSeries(dnC), dnC.length - 1).score;
  assert.ok(up > 20, `up score ${up}`); assert.ok(dn < -20, `down score ${dn}`);
  assert.equal(labelFor(80).label, 'Strong Buy'); assert.equal(labelFor(0).action, 'WAIT'); assert.equal(labelFor(-60).label, 'Strong Sell');
});

test('max drawdown', () => { assert.ok(Math.abs(maxDrawdown([100, 120, 60, 90]).mdd + 0.5) < 1e-9); });

test('full analysis on demo data: stock vs crypto risk, plan sanity, backtest', () => {
  const s = demoChart('AAPL', '1d'), c = demoChart('DOGE-USD', '1d');
  const A = analyze(s.candles, { ...s.meta }), B = analyze(c.candles, { ...c.meta });
  for (const R of [A, B]) {
    assert.ok(R.signal.score >= -100 && R.signal.score <= 100);
    assert.ok(R.risk.score >= 1 && R.risk.score <= 10);
    assert.ok(R.risk.warnings.length > 0);
    assert.ok(R.backtest.curve.length > 100);
    assert.ok(R.summary.length > 40);
    const p = R.plan;
    if (p.direction === 'long') { assert.ok(p.stop < p.entry && p.t1 > p.entry && p.t2 > p.t1); }
    else { assert.ok(p.stop > p.entry && p.t1 < p.entry); }
    assert.ok(Math.abs(p.riskDollars) <= 10000 * 0.01 + 1e-6);
  }
  assert.ok(B.risk.score > A.risk.score, `crypto ${B.risk.score} should exceed stock ${A.risk.score}`);
});

test('hourly and weekly intervals work', () => {
  for (const iv of ['1h', '1wk']) { const d = demoChart('BTC-USD', iv); assert.ok(analyze(d.candles, d.meta).risk.annVol > 0); }
});

test('API input validation', async () => {
  assert.throws(() => validate('AAPL;rm', '1d'));
  assert.throws(() => validate('AAPL', '5m'));
  assert.doesNotThrow(() => validate('BRK-B', '1wk'));
  assert.equal(assetClassOf('ETH-USD'), 'crypto'); assert.equal(assetClassOf('SPY', 'ETF'), 'etf');
  const r = await handleApi('/api/chart', new URLSearchParams('symbol=<script>&interval=1d'));
  assert.equal(r.status, 400);
  const h = await handleApi('/api/health', new URLSearchParams());
  assert.equal(h.status, 200);
});
