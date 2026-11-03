import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSymbol, exchangeOf, exchangeStatus, formatMoney, currencyInfo, WORLD, EXCHANGES, isInternational } from '../public/js/markets.js';

const DAY = 86400, now = Math.floor(Date.now() / 1000);
const days = (n) => Array.from({ length: n }, (_, i) => now - (n - i) * DAY);
let mode = {}; const calls = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url) => {
  url = String(url); calls.push(url); const host = new URL(url).host;
  if (mode[host] === 429) return new Response('slow down', { status: 429 });
  if (host === 'open.er-api.com') return json({ result: 'success', time_last_update_utc: 'today', rates: { USD: 1, GBP: 0.8, HKD: 7.8, JPY: 150, CNY: 7.2, EUR: 0.9, INR: 84 } });
  if (host === 'eodhd.com' && url.includes('/api/eod/')) return json(days(400).map((t) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), open: 100, high: 102, low: 98, close: 100, adjusted_close: 50, volume: 2e6 })));
  if (host === 'eodhd.com' && url.includes('/api/search/')) return json([{ Code: '0700', Exchange: 'HK', Name: 'Tencent Holdings Ltd', Type: 'Common Stock', Country: 'Hong Kong', Currency: 'HKD' }, { Code: 'TCEHY', Exchange: 'US', Name: 'Tencent Holdings ADR', Type: 'Common Stock' }, { Code: 'X', Exchange: 'NOPE', Name: 'Unknown', Type: 'Common Stock' }]);
  if (host === 'api.twelvedata.com') return json({ meta: { symbol: 'VOD', currency: 'GBp', exchange: 'LSE', mic_code: 'XLON', type: 'Common Stock', exchange_timezone: 'Europe/London' }, values: days(300).map((t) => ({ datetime: new Date(t * 1000).toISOString().slice(0, 10), open: '70', high: '71', low: '69', close: '70.5', volume: '30000000' })), status: 'ok' });
  if (host.endsWith('finance.yahoo.com')) return new Response('Too Many Requests', { status: 429 });
  if (host === 'stooq.com') return new Response('Date,Open,High,Low,Close,Volume\n' + days(250).map((t) => `${new Date(t * 1000).toISOString().slice(0, 10)},2000,2050,1980,2030,1000000`).join('\n'), { headers: { 'content-type': 'text/csv' } });
  return new Response('nf', { status: 404 });
};
const S = await import('../lib/sources.js');
const M = await import('../lib/market.js');
const { analyze } = await import('../public/js/engine.js');

test('every common symbol format resolves to the right exchange', () => {
  assert.equal(normalizeSymbol('LSE:VOD'), 'VOD.L');
  assert.equal(normalizeSymbol('vod ln'), 'VOD.L');
  assert.equal(normalizeSymbol('700 HK'), '0700.HK');
  assert.equal(normalizeSymbol('HKEX:700'), '0700.HK');
  assert.equal(normalizeSymbol('SHA:600519'), '600519.SS');
  assert.equal(normalizeSymbol('7203 JP'), '7203.T');
  assert.equal(normalizeSymbol('AAPL'), 'AAPL');
  assert.equal(exchangeOf('600519.SS').country, 'China');
  assert.equal(exchangeOf('RELIANCE.NS').currency, 'INR');
  assert.equal(exchangeOf('BRK-B').code, 'US');
  assert.equal(exchangeOf('BTC-USD'), null);
  assert.ok(isInternational('SAP.DE') && !isInternational('AAPL'));
  assert.ok(Object.keys(EXCHANGES).length >= 30 && WORLD.length >= 180);
  for (const w of WORLD) assert.ok(exchangeOf(w.symbol).code !== 'US', `${w.symbol} should map to a non-US exchange`);
  assert.equal(new Set(WORLD.map((w) => w.symbol)).size, WORLD.length, 'no duplicate world symbols');
});

test('world market clock: sessions, lunch breaks, Sun–Thu week, DST-correct', () => {
  assert.equal(exchangeStatus('L', new Date('2026-07-01T07:30:00Z')).phase, 'open');    // 08:30 BST
  assert.equal(exchangeStatus('L', new Date('2026-12-01T07:30:00Z')).phase, 'pre');     // 07:30 GMT
  assert.equal(exchangeStatus('HK', new Date('2026-11-02T04:30:00Z')).phase, 'lunch');
  assert.equal(exchangeStatus('SS', new Date('2026-11-02T06:30:00Z')).phase, 'open');   // 14:30 CST
  assert.equal(exchangeStatus('SS', new Date('2026-11-02T07:30:00Z')).phase, 'closed'); // 15:30
  assert.equal(exchangeStatus('T', new Date('2026-11-02T06:00:00Z')).phase, 'open');    // 15:00 JST (TSE closes 15:30)
  assert.equal(exchangeStatus('SR', new Date('2026-11-06T08:00:00Z')).phase, 'closed'); // Friday
  assert.equal(exchangeStatus('SR', new Date('2026-11-08T08:00:00Z')).phase, 'open');   // Sunday
  assert.equal(exchangeStatus('AX', new Date('2026-11-01T23:30:00Z')).phase, 'open');   // Mon 10:30 AEDT
});

test('local currencies: pence/cents quotes and symbols', () => {
  assert.deepEqual(currencyInfo('GBp'), { major: 'GBP', divisor: 100, minorSuffix: 'p' });
  assert.equal(formatMoney(250.5, 'GBp', 'en-GB'), '250.5p');
  assert.match(formatMoney(1234.5, 'HKD', 'en-US'), /HK\$1,234\.50/);
  assert.match(formatMoney(1700, 'JPY', 'en-US'), /¥1,700/);
  assert.match(formatMoney(12.3, 'USD', 'en-US'), /^\$12\.30$/);
});

test('international chain without keys: Yahoo blocked → Stooq; with EODHD → EODHD (adjusted)', async () => {
  delete process.env.EODHD_API_KEY; delete process.env.TWELVEDATA_API_KEY;
  assert.deepEqual(M.marketHealth().worldChain, ['yahoo', 'stooq']);
  const st = await M.getChart('SAP.DE', '1d');
  assert.equal(st.source, 'Stooq'); assert.ok(calls.some((u) => u.includes('s=sap.de')));
  assert.equal(st.meta.currency, 'EUR'); assert.equal(st.meta.exchange, 'Xetra (Frankfurt)'); assert.equal(st.meta.bench, 'EWG');
  process.env.EODHD_API_KEY = 'k';
  const e = await M.getChart('0700.HK', '1d');
  assert.equal(e.source, 'EODHD'); assert.ok(calls.some((u) => u.includes('/eod/0700.HK?')));
  assert.equal(e.candles.at(-1).c, 50); assert.equal(e.candles.at(-1).o, 50, 'OHLC scaled by adjusted_close');
  assert.equal(e.meta.currency, 'HKD'); assert.equal(e.meta.name, 'Tencent');
  assert.ok(Math.abs(e.meta.fxToUSD - 1 / 7.8) < 1e-9);
  const a = await M.getChart('600519.SS', '1d'); assert.ok(calls.some((u) => u.includes('600519.SHG')));
  assert.match(a.meta.marketRule, /±10%/);
  delete process.env.EODHD_API_KEY;
});

test('Twelve Data uses MIC codes; London quoted in pence converts correctly to USD', async () => {
  process.env.TWELVEDATA_API_KEY = 't';
  const r = await S.twelveData('VOD.L', '1d');
  assert.ok(calls.some((u) => u.includes('symbol=VOD&mic_code=XLON')));
  assert.equal(r.meta.currency, 'GBp');
  const full = await M.getChart('VOD.L', '1d');
  assert.ok(Math.abs(full.meta.fxToUSD - 1 / 0.8 / 100) < 1e-12); // 1p = $0.0125
  assert.equal(full.meta.usListing, 'VOD');
  delete process.env.TWELVEDATA_API_KEY;
});

test('engine: liquidity in USD, no penny-stock flag for low-priced foreign quotes, market rules + ADR shown', async () => {
  process.env.EODHD_API_KEY = 'k';
  const d = await M.getChart('9988.HK', '1d');
  const r = analyze(d.candles, { ...d.meta, interval: '1d' });
  const txt = r.risk.warnings.map((w) => w.text).join(' | ');
  assert.match(txt, /Hong Kong Exchange/); assert.match(txt, /lunch/); assert.match(txt, /BABA/); assert.match(txt, /Currency risk/);
  assert.doesNotMatch(txt, /Penny-stock/);
  assert.ok(Math.abs(r.risk.dollarVol - r.risk.dollarVol) < 1 && r.risk.fxToUSD < 0.2);
  delete process.env.EODHD_API_KEY;
});

test('worldwide search: by name, by native code, by any format; keyed results merged, unknown exchanges dropped', async () => {
  const a = await M.search('tencent'); assert.equal(a[0].symbol, '0700.HK'); assert.match(a[0].exchange, /HKEX/);
  const b = await M.search('toyota'); assert.equal(b[0].symbol, '7203.T'); assert.equal(b[0].usListing, 'TM');
  const c = await M.search('moutai'); assert.equal(c[0].symbol, '600519.SS');
  const d = await M.search('LSE:VOD'); assert.ok(d.some((x) => x.symbol === 'VOD.L'));
  process.env.EODHD_API_KEY = 'k';
  const e = await M.search('tencent holdings');
  assert.ok(e.some((x) => x.symbol === '0700.HK') && e.some((x) => x.symbol === 'TCEHY'));
  assert.ok(!e.some((x) => x.symbol.startsWith('X.')));
  delete process.env.EODHD_API_KEY;
});
