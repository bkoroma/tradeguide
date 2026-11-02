import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAccess, toChartSymbol, maskAcct, portfolio, status, connectUrl } from '../lib/brokers.js';
import { handleApi } from '../lib/market.js';

test('broker endpoints are disabled without APP_ACCESS_TOKEN', async () => {
  delete process.env.APP_ACCESS_TOKEN;
  const r = await handleApi('/api/broker/portfolio', new URLSearchParams(), { headers: {}, ip: 'a' });
  assert.equal(r.status, 503);
});

test('access code: correct, wrong, lockout', () => {
  process.env.APP_ACCESS_TOKEN = 'correct-horse-battery';
  assert.ok(checkAccess({ authorization: 'Bearer correct-horse-battery' }, 'x').ok);
  assert.equal(checkAccess({ authorization: 'Bearer nope' }, 'ip1').status, 401);
  assert.equal(checkAccess({}, 'ip1').status, 401);
  for (let i = 0; i < 8; i++) checkAccess({ authorization: 'Bearer bad' }, 'ip2');
  assert.equal(checkAccess({ authorization: 'Bearer correct-horse-battery' }, 'ip2').status, 429);
});

test('symbol normalisation and masking', () => {
  assert.equal(toChartSymbol('BTCUSD', true), 'BTC-USD');
  assert.equal(toChartSymbol('ETH/USD', true), 'ETH-USD');
  assert.equal(toChartSymbol('SOL', true), 'SOL-USD');
  assert.equal(toChartSymbol('BRK.B', false), 'BRK-B');
  assert.equal(toChartSymbol('aapl', false), 'AAPL');
  assert.equal(maskAcct('123456789'), '••6789');
});

test('demo provider returns positions; responses are no-store; unknown provider rejected', async () => {
  process.env.APP_ACCESS_TOKEN = 'correct-horse-battery';
  process.env.BROKER_DEMO = '1';
  const auth = { headers: { authorization: 'Bearer correct-horse-battery' }, ip: 'z' };
  const r = await handleApi('/api/broker/portfolio', new URLSearchParams(), auth);
  assert.equal(r.status, 200);
  assert.match(r.headers['Cache-Control'], /no-store/);
  const j = JSON.parse(r.body);
  assert.ok(j.positions.length >= 5 && j.demo);
  assert.ok(status().find((p) => p.id === 'snaptrade' && p.canConnect));
  await assert.rejects(connectUrl('alpaca'));
  const bad = await handleApi('/api/broker/connect', new URLSearchParams('provider=snaptrade'), auth);
  assert.equal(bad.status, 400); // not configured
  delete process.env.BROKER_DEMO;
});

test('no trading endpoints are exposed', async () => {
  process.env.APP_ACCESS_TOKEN = 'correct-horse-battery';
  const auth = { headers: { authorization: 'Bearer correct-horse-battery' }, ip: 'q' };
  for (const a of ['order', 'trade', 'placeOrder', 'cancel']) assert.equal((await handleApi('/api/broker/' + a, new URLSearchParams(), auth)).status, 404);
});
