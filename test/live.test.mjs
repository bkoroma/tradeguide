import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { canonicalJson } from '../lib/keys.js';
import { normalizeOrder } from '../lib/brokers.js';

const KEY = 'consumer-key-for-tests';
process.env.SNAPTRADE_CONSUMER_KEY = KEY;
const sign = (obj) => createHmac('sha256', KEY).update(canonicalJson(JSON.stringify(obj))).digest('base64');
const waitFor = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timeout'); };

test('normalizes orders from every broker into one shape', () => {
  const st = normalizeOrder('snaptrade', { brokerage_order_id: 'A1', status: 'EXECUTED', universal_symbol: { symbol: 'AAPL', type: { code: 'cs' } }, action: 'BUY', total_quantity: '10', filled_quantity: '10', execution_price: '190.5', order_type: 'Market', time_executed: '2026-11-02T14:00:00Z' }, { broker: 'Robinhood' });
  assert.deepEqual([st.symbol, st.side, st.status, st.filledQty, st.price, st.broker, st.assetClass], ['AAPL', 'BUY', 'filled', 10, 190.5, 'Robinhood', 'stock']);
  const opt = normalizeOrder('snaptrade', { brokerage_order_id: 'O1', status: 'PARTIAL', option_symbol: { ticker: 'AAPL 261218C00200000' }, action: 'BUY_OPEN', total_quantity: '2', filled_quantity: '1' });
  assert.deepEqual([opt.assetClass, opt.side, opt.status, opt.chartSymbol], ['option', 'BUY', 'partial', null]);
  const cb = normalizeOrder('coinbase', { order_id: 'C1', product_id: 'ETH-USD', order_side: 'SELL', status: 'FILLED', cumulative_quantity: '0.5', leaves_quantity: '0', avg_price: '3000' });
  assert.deepEqual([cb.chartSymbol, cb.side, cb.status, cb.qty, cb.price], ['ETH-USD', 'SELL', 'filled', 0.5, 3000]);
  const rh = normalizeOrder('robinhood', { id: 'R1', symbol: 'BTC-USD', side: 'buy', type: 'market', state: 'filled', filled_asset_quantity: '0.01', average_price: '60000', market_order_config: { asset_quantity: '0.01' }, updated_at: '2026-11-02T14:00:00Z' });
  assert.deepEqual([rh.chartSymbol, rh.status, rh.qty, rh.executedAt], ['BTC-USD', 'filled', 0.01, '2026-11-02T14:00:00Z']);
  const al = normalizeOrder('alpaca', { id: 'X', symbol: 'ETH/USD', asset_class: 'crypto', side: 'buy', status: 'partially_filled', qty: '1', filled_qty: '0.4', filled_avg_price: '3000' });
  assert.deepEqual([al.chartSymbol, al.status], ['ETH-USD', 'partial']);
});

test('SnapTrade webhook: valid signature accepted, tampered/stale/duplicate handled', async () => {
  const live = await import('../lib/live.js');
  live._test.reset();
  const body = { webhookId: 'wh-1', eventType: 'TRADE_DETECTION', eventTimestamp: new Date().toISOString(), userId: 'u', accountId: 'acct-1', details: { detection_lag_seconds: 2.5, orders: [{ brokerage_order_id: 'T1', status: 'EXECUTED', universal_symbol: { symbol: 'NVDA' }, action: 'SELL', total_quantity: '3', filled_quantity: '3', execution_price: '120.25', time_executed: new Date().toISOString() }] } };
  const raw = JSON.stringify(body, null, 2); // pretty-printed on purpose: verification must canonicalize
  assert.equal((await live.handleSnaptradeWebhook(raw, { signature: sign(body) })).status, 200);
  const ev = live.recentEvents(5).find((e) => e.id === 'T1');
  assert.ok(ev && ev.via === 'webhook' && ev.status === 'filled' && ev.detectionLagSec === 2.5);
  assert.equal((await live.handleSnaptradeWebhook(raw, { signature: sign(body) })).body.includes('duplicate'), true);
  const tampered = raw.replace('120.25', '1.25');
  assert.equal((await live.handleSnaptradeWebhook(tampered, { signature: sign(body) })).status, 401);
  const old = { ...body, webhookId: 'wh-2', eventTimestamp: new Date(Date.now() - 600e3).toISOString() };
  assert.equal((await live.handleSnaptradeWebhook(JSON.stringify(old), { signature: sign(old) })).status, 400);
});

test('Alpaca real-time stream (mock server, binary frames): auth → listen → fill pushed to hub', async () => {
  const wss = new WebSocketServer({ port: 0 });
  const port = wss.address().port;
  const got = [];
  wss.on('connection', (ws) => ws.on('message', (m) => {
    const j = JSON.parse(m.toString()); got.push(j.action);
    if (j.action === 'auth') ws.send(Buffer.from(JSON.stringify({ stream: 'authorization', data: { status: j.key === 'AK' ? 'authorized' : 'unauthorized', action: 'authenticate' } })));
    if (j.action === 'listen') {
      ws.send(Buffer.from(JSON.stringify({ stream: 'listening', data: { streams: ['trade_updates'] } })));
      ws.send(Buffer.from(JSON.stringify({ stream: 'trade_updates', data: { event: 'fill', price: '412.1', qty: '2', timestamp: new Date().toISOString(), order: { id: 'ALP-1', symbol: 'MSFT', side: 'buy', type: 'market', status: 'filled', qty: '2', filled_qty: '2', filled_avg_price: '412.1', asset_class: 'us_equity' } } })));
    }
  }));
  Object.assign(process.env, { ALPACA_KEY_ID: 'AK', ALPACA_SECRET_KEY: 'SK', ALPACA_STREAM_URL: `ws://127.0.0.1:${port}`, LIVE_NOTIFY: '0', MARKET_DEMO: '1' });
  const live = await import('../lib/live.js');
  live.startLive();
  const ev = await waitFor(() => live.recentEvents(20).find((e) => e.id === 'ALP-1'));
  assert.deepEqual([ev.symbol, ev.side, ev.status, ev.price, ev.via], ['MSFT', 'BUY', 'filled', 412.1, 'stream']);
  assert.deepEqual(got.slice(0, 2), ['auth', 'listen']);
  assert.equal(live.liveStatus().sources.alpaca.state, 'live');
  live.stopLive();
  for (const c of wss.clients) c.terminate();
  wss.close();
});

test('end-to-end: server → ticket → SSE stream receives a webhook fill in real time', async () => {
  const port = 8900 + Math.floor(Math.random() * 90);
  const envs = { ...process.env, PORT: String(port), APP_ACCESS_TOKEN: 'correct-horse-battery', BROKER_DEMO: '1', MARKET_DEMO: '1', LIVE_NOTIFY: '0', DEMO_FEED_SEC: '3600', SNAPTRADE_CONSUMER_KEY: KEY, ALPACA_KEY_ID: '', ALPACA_SECRET_KEY: '' };
  const srv = spawn(process.execPath, ['server.js'], { env: envs, stdio: 'pipe' });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let k = 0; k < 40; k++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* */ } await new Promise((r) => setTimeout(r, 100)); }
    assert.equal((await fetch(`${base}/api/live/ticket`)).status, 401);
    const { ticket } = await (await fetch(`${base}/api/live/ticket`, { headers: { Authorization: 'Bearer correct-horse-battery' } })).json();
    assert.equal((await fetch(`${base}/api/live/stream?ticket=bad.ticket`)).status, 401);
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/live/stream?ticket=${encodeURIComponent(ticket)}`, { signal: ctrl.signal });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader(); let buf = '';
    const readUntil = async (re) => { const t = Date.now(); while (Date.now() - t < 8000) { const { value } = await reader.read(); buf += new TextDecoder().decode(value); if (re.test(buf)) return; } throw new Error('stream timeout: ' + buf.slice(-300)); };
    await readUntil(/event: hello/);
    const body = { webhookId: 'wh-e2e', eventType: 'TRADE_DETECTION', eventTimestamp: new Date().toISOString(), accountId: 'a', details: { orders: [{ brokerage_order_id: 'E2E-1', status: 'EXECUTED', universal_symbol: { symbol: 'AMD' }, action: 'BUY', total_quantity: '7', filled_quantity: '7', execution_price: '150' }] } };
    const wh = await fetch(`${base}/api/webhooks/snaptrade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Signature: sign(body) }, body: JSON.stringify(body) });
    assert.equal(wh.status, 200);
    await readUntil(/E2E-1/);
    assert.match(buf, /event: order\ndata: .*"symbol":"AMD"/);
    const bad = await fetch(`${base}/api/webhooks/snaptrade`, { method: 'POST', headers: { Signature: 'nope' }, body: JSON.stringify(body) });
    assert.equal(bad.status, 401);
    ctrl.abort();
  } finally { srv.kill('SIGKILL'); }
});

test('Coinbase real-time user channel (mock server): JWT-subscribed, snapshot vs update handled', async () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const wss = new WebSocketServer({ port: 0 });
  const subs = [];
  wss.on('connection', (ws) => ws.on('message', (m) => {
    const j = JSON.parse(m.toString()); subs.push(j);
    if (j.channel === 'user') {
      ws.send(JSON.stringify({ channel: 'subscriptions', events: [{ subscriptions: { user: ['x'] } }] }));
      ws.send(JSON.stringify({ channel: 'user', sequence_num: 1, events: [{ type: 'snapshot', orders: [{ order_id: 'CB-OPEN', product_id: 'SOL-USD', order_side: 'BUY', order_type: 'LIMIT', status: 'OPEN', cumulative_quantity: '0', leaves_quantity: '3', avg_price: '0' }] }] }));
      ws.send(JSON.stringify({ channel: 'user', sequence_num: 2, events: [{ type: 'update', orders: [{ order_id: 'CB-FILL', product_id: 'ETH-USD', order_side: 'SELL', order_type: 'MARKET', status: 'FILLED', cumulative_quantity: '0.25', leaves_quantity: '0', avg_price: '3100.5' }] }] }));
    }
  }));
  Object.assign(process.env, { ALPACA_KEY_ID: '', ALPACA_SECRET_KEY: '', COINBASE_API_KEY_NAME: 'organizations/o/apiKeys/k', COINBASE_API_PRIVATE_KEY: privateKey.export({ type: 'sec1', format: 'pem' }), COINBASE_WS_URL: `ws://127.0.0.1:${wss.address().port}`, LIVE_NOTIFY: '0' });
  const live = await import('../lib/live.js');
  live.stopLive(); live._test.reset(); live.startLive();
  const fill = await waitFor(() => live.recentEvents(20).find((e) => e.id === 'CB-FILL'));
  const open = live.recentEvents(20).find((e) => e.id === 'CB-OPEN');
  assert.deepEqual([fill.side, fill.status, fill.price, fill.via, fill.snapshot], ['SELL', 'filled', 3100.5, 'stream', false]);
  assert.ok(open && open.snapshot && open.status === 'open');
  const userSub = subs.find((x) => x.channel === 'user');
  const claims = JSON.parse(Buffer.from(userSub.jwt.split('.')[1], 'base64url').toString());
  assert.equal(claims.iss, 'cdp'); assert.equal(claims.uri, undefined); assert.ok(subs.some((x) => x.channel === 'heartbeats'));
  live.stopLive(); for (const c of wss.clients) c.terminate(); wss.close();
  for (const k of ['COINBASE_API_KEY_NAME', 'COINBASE_API_PRIVATE_KEY']) delete process.env[k];
});
