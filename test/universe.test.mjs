import test from 'node:test';
import assert from 'node:assert/strict';

// Fixtures in the official formats (Nasdaq Trader pipe files, Coinbase /products & /currencies, Kraken AssetPairs)
const NASDAQ = `Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares
AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N
QQQ|Invesco QQQ Trust, Series 1|G|N|N|100|Y|N
ZVZZT|NASDAQ TEST STOCK|G|Y|N|100|N|N
ABCDW|ABCD Corp - Warrant|S|N|N|100|N|N
${Array.from({ length: 1200 }, (_, i) => `T${i}X|Test Filler ${i} Inc. - Common Stock|S|N|N|100|N|N`).join('\n')}
File Creation Time: 1102202622:00|||||||`;
const OTHER = `ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol
BRK.B|Berkshire Hathaway Inc. New Common Stock|N|BRK.B|N|100|N|BRK.B
SPY|SPDR S&P 500 ETF Trust|P|SPY|Y|100|N|SPY
VOO|Vanguard S&P 500 ETF|P|VOO|Y|100|N|VOO
ABR$D|Arbor Realty Preferred D|N|ABRpD|N|100|N|ABR-D
File Creation Time: 1102202622:00|||||||`;
const CB_PRODUCTS = [
  { id: 'BTC-USD', base_currency: 'BTC', quote_currency: 'USD', status: 'online', trading_disabled: false },
  { id: 'ETH-USD', base_currency: 'ETH', quote_currency: 'USD', status: 'online' },
  { id: 'USDT-USD', base_currency: 'USDT', quote_currency: 'USD', status: 'online' },
  { id: 'OLD-USD', base_currency: 'OLD', quote_currency: 'USD', status: 'delisted' },
  { id: 'SOL-EUR', base_currency: 'SOL', quote_currency: 'EUR', status: 'online' },
  ...Array.from({ length: 30 }, (_, i) => ({ id: `C${i}-USD`, base_currency: `C${i}`, quote_currency: 'USD', status: 'online' })),
];
const CB_CURRENCIES = [{ id: 'BTC', name: 'Bitcoin' }, { id: 'ETH', name: 'Ethereum' }];
const KRAKEN = { error: [], result: { XXBTZUSD: { altname: 'XBTUSD', wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' }, XDGUSD: { altname: 'XDGUSD', wsname: 'XDG/USD', base: 'XXDG', quote: 'ZUSD', status: 'online' }, KASUSD: { altname: 'KASUSD', wsname: 'KAS/USD', status: 'online' } } };

let down = false;
globalThis.fetch = async (url) => {
  url = String(url);
  if (down) return new Response('busy', { status: 503 });
  const ok = (b, ct = 'application/json') => new Response(typeof b === 'string' ? b : JSON.stringify(b), { headers: { 'content-type': ct } });
  if (url.endsWith('nasdaqlisted.txt')) return ok(NASDAQ, 'text/plain');
  if (url.endsWith('otherlisted.txt')) return ok(OTHER, 'text/plain');
  if (url.endsWith('/products')) return ok(CB_PRODUCTS);
  if (url.endsWith('/currencies')) return ok(CB_CURRENCIES);
  if (url.includes('AssetPairs')) return ok(KRAKEN);
  if (url.includes('yahoo')) return new Response('no', { status: 429 });
  return new Response('nf', { status: 404 });
};

const U = await import('../lib/universe.js');
const M = await import('../lib/market.js');

test('parses every US stock & ETF: test issues and $-preferreds dropped, class shares normalised', async () => {
  const st = await U.loadUniverse(true);
  const sym = new Set(st.stocks.map((x) => x.symbol));
  assert.ok(sym.has('AAPL') && sym.has('QQQ') && sym.has('SPY') && sym.has('BRK-B'));
  assert.ok(!sym.has('ZVZZT') && !sym.has('ABR$D'));
  assert.equal(st.bySymbol.get('AAPL').name, 'Apple Inc.');
  assert.equal(st.bySymbol.get('SPY').assetClass, 'etf');
  assert.equal(st.bySymbol.get('QQQ').assetClass, 'etf');
  assert.equal(st.bySymbol.get('SPY').exchange, 'NYSE Arca');
  assert.equal(st.bySymbol.get('ABCDW').other, true);
  const stats = U.universeStats(); assert.ok(stats.stocks > 1200 && stats.etfs === 3 && stats.crypto > 30);
});

test('crypto: every USD pair on Coinbase + Kraken, no stablecoins or delisted, Kraken names mapped', async () => {
  const st = await U.loadUniverse();
  const c = new Map(st.crypto.map((x) => [x.symbol, x]));
  assert.equal(c.get('BTC-USD').name, 'Bitcoin');
  assert.equal(c.get('BTC-USD').exchange, 'Coinbase · Kraken');
  assert.ok(c.has('DOGE-USD') && c.has('KAS-USD'));
  assert.ok(!c.has('USDT-USD') && !c.has('OLD-USD') && !c.has('SOL-USD'));
});

test('search ranks exact ticker first, finds by company name, filters by class, ignores Yahoo being blocked', async () => {
  const r1 = await M.search('spy'); assert.equal(r1[0].symbol, 'SPY'); assert.equal(r1[0].assetClass, 'etf');
  const r2 = await M.search('berkshire'); assert.equal(r2[0].symbol, 'BRK-B');
  const r3 = await M.search('bitcoin'); assert.equal(r3[0].symbol, 'BTC-USD');
  const r4 = await M.search('s&p 500', 'etf'); assert.ok(r4.length >= 2 && r4.every((x) => x.assetClass === 'etf'));
  const r5 = await M.search('ABCD'); assert.ok(!r5.length || r5[0].symbol !== 'ABCDW' || r5.length === 1);
});

test('browse pages through all ETFs / all crypto; API endpoint validates input', async () => {
  const b = await U.browse({ cls: 'etf', offset: 0, limit: 2 });
  assert.equal(b.total, 3); assert.deepEqual(b.items.map((x) => x.symbol), ['QQQ', 'SPY']);
  const r = await M.handleApi('/api/universe', new URLSearchParams('class=crypto&limit=5&offset=1'));
  const j = JSON.parse(r.body); assert.equal(r.status, 200); assert.equal(j.items.length, 5); assert.ok(j.total > 30);
  const h = JSON.parse((await M.handleApi('/api/health', new URLSearchParams())).body); assert.ok(h.universe.etfs === 3);
});

test('if the directories are unreachable, the built-in list keeps search working', async () => {
  U._test.reset(); down = true;
  const st = await U.loadUniverse(true);
  assert.ok(st.stocks.some((x) => x.symbol === 'VOO' && x.assetClass === 'etf'));
  assert.ok(st.crypto.some((x) => x.symbol === 'ETH-USD'));
  assert.equal(st.errors.length, 2);
  down = false;
});
