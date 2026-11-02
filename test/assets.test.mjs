import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, classVolatility, marketStatus, PROFILES } from '../public/js/assets.js';
import { riskReport, computeSeries, tradePlan } from '../public/js/engine.js';
import { demoChart } from '../public/js/data.js';

test('classify: stock, ETF, crypto, crypto-linked, leveraged', () => {
  assert.equal(classify('AAPL').cls, 'stock');
  assert.equal(classify('SPY').cls, 'etf');
  assert.equal(classify('SPY', 'etf').cls, 'etf');
  assert.equal(classify('BTC-USD').cls, 'crypto');
  assert.equal(classify('SOL-USD', 'stock').cls, 'crypto');
  assert.ok(classify('COIN').cryptoLinked && classify('IBIT', 'etf').cryptoLinked);
  assert.ok(!classify('MSFT').cryptoLinked);
  assert.ok(classify('TQQQ', 'etf', 'ProShares UltraPro QQQ').leveraged);
});

test('volatility is judged against the asset class', () => {
  assert.equal(classVolatility('stock', 0.5).level, 'Volatile');
  assert.equal(classVolatility('crypto', 0.5).level, 'Typical');
  assert.equal(classVolatility('crypto', 1.5).level, 'Extreme');
  assert.equal(classVolatility('etf', 0.1).level, 'Calm');
});

test('market clock: crypto always open; stocks follow NYSE hours, weekends, holidays, early closes', () => {
  const et = (iso) => new Date(iso); // ISO with explicit offset
  assert.equal(marketStatus('crypto', et('2026-11-01T03:00:00-05:00')).open, true);          // Sunday night
  assert.equal(marketStatus('stock', et('2026-11-02T10:00:00-05:00')).phase, 'open');        // Mon 10:00 ET
  assert.equal(marketStatus('stock', et('2026-11-02T08:00:00-05:00')).phase, 'pre');
  assert.equal(marketStatus('stock', et('2026-11-02T17:00:00-05:00')).phase, 'post');
  assert.match(marketStatus('stock', et('2026-11-01T12:00:00-05:00')).label, /Weekend/);     // Sunday
  assert.match(marketStatus('stock', et('2026-11-26T12:00:00-05:00')).label, /Holiday/);     // Thanksgiving
  assert.equal(marketStatus('stock', et('2026-11-27T12:30:00-05:00')).phase, 'open');        // half day
  assert.equal(marketStatus('stock', et('2026-11-27T13:30:00-05:00')).phase, 'post');        // after 1pm early close
  assert.match(marketStatus('stock', et('2026-11-27T21:00:00-05:00')).detail, /Mon/);       // Fri night → next open Monday
});

test('engine: class-specific warnings and stop width', () => {
  const c = demoChart('SOL-USD', '1d'), s = demoChart('MSFT', '1d'), l = demoChart('COIN', '1d');
  const rc = riskReport(c.candles, computeSeries(c.candles), c.meta, null);
  const rs = riskReport(s.candles, computeSeries(s.candles), s.meta, null);
  const rl = riskReport(l.candles, computeSeries(l.candles), l.meta, null);
  assert.equal(rc.assetClass, 'crypto'); assert.equal(rs.assetClass, 'stock');
  assert.ok(rc.warnings.some((w) => /24\/7/.test(w.text)));
  assert.ok(rs.warnings.some((w) => /Mon–Fri/.test(w.text)));
  assert.ok(rl.warnings.some((w) => /Crypto-linked/.test(w.text)));
  const Sc = computeSeries(c.candles), atr = Sc.atr.at(-1);
  const pc = tradePlan(Sc, { action: 'BUY' }, rc, {});
  assert.ok(Math.abs(pc.entry - pc.stop) <= 4 * atr + 1e-9);
  assert.equal(PROFILES.crypto.suggestRiskPct, 0.5);
});
