import test from 'node:test';
import assert from 'node:assert/strict';

// Fake upstream APIs (exact response shapes from each provider's docs)
const DAY = 86400, now = Math.floor(Date.now() / 1000);
const days = (n) => Array.from({ length: n }, (_, i) => now - (n - i) * DAY);
let mode = {};
const calls = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  url = String(url); calls.push(url);
  const host = new URL(url).host;
  if (mode[host] === 429) return new Response('Too Many Requests', { status: 429 });
  if (mode[host] === 'timeout') { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }
  if (host.endsWith('finance.yahoo.com')) return json({ chart: { result: [{ meta: { symbol: 'AAPL', longName: 'Apple Inc.', currency: 'USD', instrumentType: 'EQUITY' }, timestamp: days(300), indicators: { quote: [{ open: days(300).map(() => 100), high: days(300).map(() => 101), low: days(300).map(() => 99), close: days(300).map((_, i) => 100 + i / 10), volume: days(300).map(() => 1e6) }] } }] } });
  if (host === 'api.nasdaq.com') return json({ data: { tradesTable: { rows: days(400).reverse().map((t, i) => { const d = new Date(t * 1000); return { date: `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`, close: `$${(190 - i / 10).toFixed(2)}`, volume: '45,123,456', open: '$189.50', high: '$191.00', low: '$188.75' }; }) } } });
  if (host === 'stooq.com') return new Response('Date,Open,High,Low,Close,Volume\n' + days(200).map((t) => `${new Date(t * 1000).toISOString().slice(0, 10)},10,11,9,10.5,1000`).join('\n'), { headers: { 'content-type': 'text/csv' } });
  if (host === 'data.alpaca.markets' && url.includes('/crypto/')) return json({ bars: { 'BTC/USD': days(500).map((t) => ({ t: new Date(t * 1000).toISOString(), o: 60000, h: 61000, l: 59000, c: 60500, v: 12.5 })) }, next_page_token: null });
  if (host === 'data.alpaca.markets') return json({ bars: days(700).map((t) => ({ t: new Date(t * 1000).toISOString(), o: 200, h: 202, l: 198, c: 201, v: 5e5, vw: 200 })), symbol: 'AAPL', next_page_token: null });
  if (host === 'api.tiingo.com') return json(days(700).map((t) => ({ date: new Date(t * 1000).toISOString(), open: 1, high: 1, low: 1, close: 1, adjOpen: 300, adjHigh: 303, adjLow: 297, adjClose: 301, adjVolume: 2e6 })));
  if (host === 'api.exchange.coinbase.com') { const p = new URL(url).searchParams; const s = Date.parse(p.get('start')) / 1000, e = Date.parse(p.get('end')) / 1000; const out = []; for (let t = Math.floor(e / DAY) * DAY; t >= s; t -= DAY) out.push([t, 2900, 3100, 3000, 3050, 1234.5]); return json(out); }
  if (host === 'api.kraken.com') return json({ error: [], result: { XXBTZUSD: days(720).map((t) => [t, '60000.0', '61000.0', '59000.0', '60500.0', '60200.0', '12.3', 100]), last: now } });
  if (host === 'api.binance.us') return json(days(500).map((t) => [t * 1000, '1', '1.1', '0.9', '1.05', '1000', t * 1000 + 1, '0', 1, '0', '0', '0']));
  return new Response('not found', { status: 404 });
};

const S = await import('../lib/sources.js');
const M = await import('../lib/market.js');
const reset = () => { mode = {}; calls.length = 0; S._test.breaker.clear(); for (const k of ['ALPACA_KEY_ID', 'ALPACA_SECRET_KEY', 'ALPACA_DATA_KEY_ID', 'ALPACA_DATA_SECRET_KEY', 'TIINGO_API_KEY']) delete process.env[k]; };

test('each source parses its real response format', async () => {
  reset();
  const y = await S.yahoo('AAPL', '1d', M.assetClassOf); assert.equal(y.candles.length, 300); assert.equal(y.meta.name, 'Apple Inc.');
  const n = await S.nasdaq('AAPL', '1d'); assert.ok(n.candles.length >= 399); assert.equal(n.candles.at(-1).o, 189.5); assert.equal(n.candles.at(-1).v, 45123456); assert.ok(n.candles[0].t < n.candles.at(-1).t, 'sorted oldest→newest');
  const st = await S.stooq('AAPL', '1d'); assert.equal(st.candles.length, 200);
  const cb = await S.coinbase('ETH-USD', '1d'); assert.ok(cb.candles.length > 1000); assert.deepEqual([cb.candles[5].o, cb.candles[5].h, cb.candles[5].l, cb.candles[5].c], [3000, 3100, 2900, 3050]);
  const kr = await S.kraken('BTC-USD', '1d'); assert.equal(kr.candles.length, 719); assert.ok(calls.some((u) => u.includes('pair=XBTUSD')));
  const ac = await S.alpacaCrypto('BTC-USD', '1d'); assert.equal(ac.candles.length, 500); assert.ok(calls.some((u) => u.includes('symbols=BTC%2FUSD')));
  const bn = await S.binanceUS('SOL-USD', '1d'); assert.equal(bn.candles.length, 500);
  const wk = await S.coinbase('ETH-USD', '1wk'); assert.ok(wk.candles.length > 400 && wk.candles.length < 560, `weekly bars ${wk.candles.length}`);
});

test('your exact failure (Yahoo 429 + Stooq timeout) now falls through to Nasdaq', async () => {
  reset();
  mode = { 'query1.finance.yahoo.com': 429, 'query2.finance.yahoo.com': 429, 'stooq.com': 'timeout' };
  const r = await M.getChart('AMD', '1d');
  assert.equal(r.source, 'Nasdaq');
  assert.equal(r.meta.assetClass, 'stock');
  assert.equal(M.marketHealth().sources.yahoo.status, 'cooling-down');
  const yahooCalls = calls.filter((u) => u.includes('yahoo')).length;
  await M.getChart('INTC', '1d'); // Yahoo is skipped instantly while cooling down
  assert.equal(calls.filter((u) => u.includes('yahoo')).length, yahooCalls);
});

test('free API keys put Alpaca / Tiingo first for stocks', async () => {
  reset();
  process.env.ALPACA_DATA_KEY_ID = 'k'; process.env.ALPACA_DATA_SECRET_KEY = 's';
  assert.deepEqual(M.marketHealth().stockChain, ['alpaca', 'yahoo', 'nasdaq', 'stooq']);
  assert.equal((await M.getChart('MSFT', '1d')).source, 'Alpaca (IEX)');
  reset(); process.env.TIINGO_API_KEY = 't';
  const t = await M.getChart('NVDA', '1wk'); assert.equal(t.source, 'Tiingo'); assert.equal(t.candles.at(-1).c, 301);
  reset();
});

test('crypto never depends on Yahoo, and survives several dead sources', async () => {
  reset();
  mode = { 'data.alpaca.markets': 429, 'api.exchange.coinbase.com': 'timeout' };
  const r = await M.getChart('DOGE-USD', '1d');
  assert.equal(r.source, 'Kraken'); assert.ok(calls.some((u) => u.includes('pair=XDGUSD')));
  assert.ok(!calls.some((u) => u.includes('yahoo')));
});

test('everything down with no cached copy → a clear error naming each source', async () => {
  reset();
  await M.getChart('QQQ', '1h').catch(() => {}); // Yahoo has 1h
  mode = Object.fromEntries(['query1.finance.yahoo.com', 'query2.finance.yahoo.com', 'api.nasdaq.com', 'stooq.com'].map((h) => [h, 429]));
  S._test.breaker.clear();
  await assert.rejects(M.getChart('ZZZZ', '1d'), /No market data for ZZZZ/);
  reset();
});

test('search falls back to the built-in list when Yahoo search is blocked', async () => {
  reset(); mode = { 'query2.finance.yahoo.com': 429 };
  const r = await M.search('bitcoin');
  assert.ok(r.some((x) => x.symbol === 'BTC-USD'));
  reset();
});
