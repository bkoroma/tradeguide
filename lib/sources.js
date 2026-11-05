// TradeGuide — market-data sources with automatic failover.
//
// Cloud hosts (Render, Netlify, Vercel…) are often rate-limited by Yahoo (HTTP 429), so no single
// free source is trusted. Each request walks a chain; a source that returns 429/403/5xx or times out
// is put on a cool-down ("circuit breaker") so later requests skip it instantly.
//
//   Stocks/ETFs: Alpaca data* → Tiingo* → Yahoo → Nasdaq → Stooq
//   Crypto:      Alpaca crypto (no key needed) → Coinbase Exchange → Kraken → Yahoo → Binance.US
//   (* only when a free API key is set — the most reliable option for stocks on cloud hosts)

import { exchangeOf, EXCHANGES } from '../public/js/markets.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const env = (k) => (process.env[k] || '').trim();

// ---------- HTTP with per-source circuit breaker ----------
const breaker = new Map(); // source -> { until, reason, fails }
export function sourceHealth() {
  const now = Date.now();
  return Object.fromEntries([...breaker].map(([k, v]) => [k, v.until > now ? { status: 'cooling-down', retryInSec: Math.round((v.until - now) / 1000), reason: v.reason } : { status: 'ok', lastError: v.reason || null }]));
}
function trip(source, reason, ms) { const b = breaker.get(source) || { fails: 0 }; b.fails++; b.reason = reason; b.until = Date.now() + Math.min(ms * b.fails, 30 * 60_000); breaker.set(source, b); }
function ok(source) { const b = breaker.get(source); if (b) { b.fails = 0; b.until = 0; } }
const cooling = (source) => (breaker.get(source)?.until || 0) > Date.now();

export async function http(source, url, { headers = {}, timeout = 12_000, as = 'auto' } = {}) {
  if (cooling(source)) throw new Error(`${source} cooling down (${breaker.get(source).reason})`);
  let r;
  try {
    r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json,text/csv,text/plain,*/*', ...headers }, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    const reason = e.name === 'TimeoutError' || e.name === 'AbortError' ? `timeout after ${timeout / 1000}s` : e.message;
    trip(source, reason, 2 * 60_000);
    throw new Error(reason);
  }
  if (r.status === 429 || r.status === 403) { trip(source, `HTTP ${r.status}`, 10 * 60_000); throw new Error(`HTTP ${r.status} (rate-limited)`); }
  if (r.status >= 500) { trip(source, `HTTP ${r.status}`, 2 * 60_000); throw new Error(`HTTP ${r.status}`); }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  ok(source);
  const ct = r.headers.get('content-type') || '';
  if (as === 'text') return r.text();
  if (as === 'json' || ct.includes('json')) return r.json();
  return r.text();
}

// ---------- helpers ----------
const SPAN = { '1h': 180 * 86400, '1d': 3 * 365 * 86400, '1wk': 10 * 365 * 86400 }; // history to request
const isoDay = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const nowSec = () => Math.floor(Date.now() / 1000);
const num = (x) => (x == null || x === '' ? NaN : +String(x).replace(/[$,]/g, ''));
const clean = (rows) => {
  const out = []; let last = -Infinity;
  for (const c of rows.sort((a, b) => a.t - b.t)) if (c.t > last && [c.o, c.h, c.l, c.c].every((x) => Number.isFinite(x) && x > 0)) { out.push({ ...c, v: Number.isFinite(c.v) ? c.v : 0 }); last = c.t; }
  return out;
};
// daily → weekly (week starting Monday, UTC)
function toWeekly(daily) {
  const out = [];
  for (const c of daily) {
    const d = new Date(c.t * 1000), wk = Math.floor((c.t - ((d.getUTCDay() + 6) % 7) * 86400) / 86400) * 86400;
    const w = out[out.length - 1];
    if (w && w.t === wk) { w.h = Math.max(w.h, c.h); w.l = Math.min(w.l, c.l); w.c = c.c; w.v += c.v; }
    else out.push({ t: wk, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
  }
  return out;
}
const cryptoBase = (s) => s.toUpperCase().replace(/-(USD|USDT|USDC)$/, '');
const meta = (symbol, interval, extra) => ({ symbol: symbol.toUpperCase(), name: symbol.toUpperCase(), currency: 'USD', exchange: '', quoteType: '', interval, ...extra });

// ---------- Stocks & ETFs ----------
function alpacaKeys() {
  const id = env('ALPACA_DATA_KEY_ID') || env('ALPACA_KEY_ID'), sec = env('ALPACA_DATA_SECRET_KEY') || env('ALPACA_SECRET_KEY');
  return id && sec ? { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': sec } : null;
}

export async function alpacaStock(symbol, interval) {
  const headers = alpacaKeys();
  if (!headers) throw new Error('not configured (set ALPACA_DATA_KEY_ID / ALPACA_DATA_SECRET_KEY — free)');
  const tf = { '1h': '1Hour', '1d': '1Day', '1wk': '1Week' }[interval];
  const start = new Date((nowSec() - SPAN[interval]) * 1000).toISOString();
  const sym = symbol.toUpperCase().replace('-', '.'); // Alpaca uses BRK.B
  const rows = []; let token = '';
  for (let page = 0; page < 5; page++) {
    const j = await http('alpaca', `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(sym)}/bars?timeframe=${tf}&start=${encodeURIComponent(start)}&limit=10000&adjustment=all&feed=${env('ALPACA_DATA_FEED') || 'iex'}${token ? `&page_token=${encodeURIComponent(token)}` : ''}`, { headers, as: 'json' });
    for (const b of j.bars || []) rows.push({ t: Math.floor(Date.parse(b.t) / 1000), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    token = j.next_page_token; if (!token) break;
  }
  return { source: 'Alpaca (IEX)', meta: meta(symbol, interval, { exchange: 'US' }), candles: clean(rows) };
}

export async function tiingoStock(symbol, interval) {
  const key = env('TIINGO_API_KEY');
  if (!key) throw new Error('not configured (set TIINGO_API_KEY — free)');
  const t = symbol.toLowerCase().replace('.', '-');
  const start = isoDay(nowSec() - SPAN[interval]);
  let rows;
  if (interval === '1h') {
    rows = await http('tiingo', `https://api.tiingo.com/iex/${encodeURIComponent(t)}/prices?startDate=${start}&resampleFreq=1hour&columns=open,high,low,close,volume&token=${key}`, { as: 'json' });
    rows = rows.map((r) => ({ t: Math.floor(Date.parse(r.date) / 1000), o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume }));
  } else {
    rows = await http('tiingo', `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(t)}/prices?startDate=${start}&resampleFreq=${interval === '1wk' ? 'weekly' : 'daily'}&token=${key}`, { as: 'json' });
    rows = rows.map((r) => ({ t: Math.floor(Date.parse(r.date) / 1000), o: r.adjOpen ?? r.open, h: r.adjHigh ?? r.high, l: r.adjLow ?? r.low, c: r.adjClose ?? r.close, v: r.adjVolume ?? r.volume }));
  }
  return { source: 'Tiingo', meta: meta(symbol, interval, { exchange: 'US' }), candles: clean(rows) };
}

const Y_CFG = { '1h': ['1h', '6mo'], '1d': ['1d', '3y'], '1wk': ['1wk', '10y'] };
export async function yahoo(symbol, interval, assetClassOf) {
  const [iv, range] = Y_CFG[interval];
  let j, lastErr;
  for (const host of ['query1', 'query2']) {
    try { j = await http(`yahoo`, `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${iv}&range=${range}&includePrePost=false&events=div,split`, { as: 'json', timeout: 9000 }); break; }
    catch (e) { lastErr = e; if (/cooling|429|403/.test(e.message)) break; }
  }
  if (!j) throw lastErr;
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(j?.chart?.error?.description || 'no data');
  const q = res.indicators?.quote?.[0] || {}, ts = res.timestamp || [];
  const rows = ts.map((t, i) => ({ t, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i] ?? 0 })).filter((c) => c.o != null && c.c != null);
  const m = res.meta || {};
  return {
    source: 'Yahoo Finance',
    meta: meta(symbol, interval, { symbol: m.symbol || symbol, name: m.longName || m.shortName || m.symbol || symbol, currency: m.currency || 'USD', exchange: m.fullExchangeName || m.exchangeName || '', quoteType: m.instrumentType || '', assetClass: assetClassOf(symbol, m.instrumentType) }),
    candles: clean(rows),
  };
}

// Nasdaq.com public JSON (undocumented; best effort, daily only). Two endpoint shapes are tried.
export async function nasdaq(symbol, interval) {
  if (interval === '1h') throw new Error('no intraday');
  const to = isoDay(nowSec()), from = isoDay(nowSec() - SPAN[interval]);
  const headers = { Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/', 'Accept-Language': 'en-US,en;q=0.9' };
  const sym = encodeURIComponent(symbol.toUpperCase().replace('-', '.'));
  const notes = [];
  let daily = null;
  for (const ac of ['stocks', 'etf']) {
    try {
      const j = await http('nasdaq', `https://api.nasdaq.com/api/quote/${sym}/historical?assetclass=${ac}&fromdate=${from}&todate=${to}&limit=9999`, { headers, as: 'json', timeout: 12_000 });
      const r = j?.data?.tradesTable?.rows;
      if (Array.isArray(r) && r.length) {
        daily = r.map((x) => { const [mm, dd, yy] = String(x.date).split('/'); return { t: Math.floor(Date.UTC(+yy, +mm - 1, +dd, 21) / 1000), o: num(x.open), h: num(x.high), l: num(x.low), c: num(x.close), v: num(x.volume) }; });
        break;
      }
      notes.push(`historical/${ac}: ${j?.status?.bCodeMessage?.[0]?.errorMessage || (j?.data === null ? 'data=null' : 'no rows')}`);
    } catch (e) { notes.push(`historical/${ac}: ${e.message}`); if (/cooling|429|403/.test(e.message)) break; }
  }
  if (!daily) {
    try { // community-documented chart endpoint: data.chart[].z {open,high,low,close,volume,dateTime}
      const j = await http('nasdaq', `https://api.nasdaq.com/api/quote/${sym}/chart?assetclass=stocks&fromdate=${from}&todate=${to}`, { headers, as: 'json', timeout: 12_000 });
      const c = j?.data?.chart;
      if (Array.isArray(c) && c.length) daily = c.map((x) => { const z = x.z || x; const t = Date.parse(z.dateTime || z.date || '') || (x.x ? x.x : NaN); return { t: Math.floor((t > 1e12 ? t : t * 1) / 1000), o: num(z.open), h: num(z.high), l: num(z.low), c: num(z.close ?? x.y), v: num(z.volume) }; });
      else notes.push(`chart: ${j?.data === null ? 'data=null' : 'no points'}`);
    } catch (e) { notes.push(`chart: ${e.message}`); }
  }
  if (!daily) throw new Error(`no data (${notes.join('; ')})`);
  const candles = clean(daily);
  return { source: 'Nasdaq', meta: meta(symbol, interval, { exchange: 'US' }), candles: interval === '1wk' ? toWeekly(candles) : candles };
}

export async function stooq(symbol, interval) {
  if (interval === '1h') throw new Error('no intraday');
  const s = symbol.toLowerCase().replace(/\./g, '-') + (symbol.includes('.') ? '' : '.us');
  const csv = await http('stooq', `https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=${interval === '1wk' ? 'w' : 'd'}`, { as: 'text', timeout: 20_000 });
  if (typeof csv !== 'string' || !csv.startsWith('Date')) throw new Error(/apikey|captcha/i.test(String(csv)) ? 'requires an API key now' : `no data (${String(csv).replace(/\s+/g, ' ').slice(0, 80)})`);
  const rows = csv.trim().split('\n').slice(1).slice(interval === '1wk' ? -520 : -760).map((ln) => {
    const [d, o, h, l, c, v] = ln.split(',');
    return { t: Math.floor(Date.parse(d + 'T21:00:00Z') / 1000), o: +o, h: +h, l: +l, c: +c, v: +(v || 0) };
  });
  return { source: 'Stooq', meta: meta(symbol, interval, { exchange: 'US' }), candles: clean(rows) };
}

// ---------- International (and US) via keyed global providers ----------
// EODHD: every major exchange (free key = 20 calls/day for testing; "EOD All World" plan for real use)
export async function eodhd(symbol, interval) {
  const key = env('EODHD_API_KEY');
  if (!key) throw new Error('not configured (set EODHD_API_KEY)');
  const ex = exchangeOf(symbol);
  const code = ex.code === 'US' ? 'US' : ex.eodhd;
  if (!code) throw new Error(`${ex.short} not mapped for EODHD`);
  const tk = `${ex.base.replace('-', '.')}.${code}`;
  let rows;
  if (interval === '1h') {
    const j = await http('eodhd', `https://eodhd.com/api/intraday/${encodeURIComponent(tk)}?interval=1h&from=${nowSec() - SPAN['1h']}&to=${nowSec()}&fmt=json&api_token=${key}`, { as: 'json' });
    rows = (Array.isArray(j) ? j : []).map((r) => ({ t: r.timestamp, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume }));
  } else {
    const j = await http('eodhd', `https://eodhd.com/api/eod/${encodeURIComponent(tk)}?from=${isoDay(nowSec() - SPAN[interval])}&period=${interval === '1wk' ? 'w' : 'd'}&fmt=json&api_token=${key}`, { as: 'json' });
    rows = (Array.isArray(j) ? j : []).map((r) => { const f = r.close ? (r.adjusted_close ?? r.close) / r.close : 1; return { t: Math.floor(Date.parse(r.date + 'T12:00:00Z') / 1000), o: r.open * f, h: r.high * f, l: r.low * f, c: r.adjusted_close ?? r.close, v: r.volume }; });
  }
  return { source: 'EODHD', meta: meta(symbol, interval, { exchange: ex.name, currency: ex.currency }), candles: clean(rows) };
}

// Twelve Data: free key covers US; international exchanges need a paid plan
export async function twelveData(symbol, interval) {
  const key = env('TWELVEDATA_API_KEY');
  if (!key) throw new Error('not configured (set TWELVEDATA_API_KEY)');
  const ex = exchangeOf(symbol);
  const q = ex.code === 'US' ? `symbol=${encodeURIComponent(ex.base.replace('-', '.'))}` : `symbol=${encodeURIComponent(ex.base)}&mic_code=${ex.mic}`;
  const j = await http('twelvedata', `https://api.twelvedata.com/time_series?${q}&interval=${{ '1h': '1h', '1d': '1day', '1wk': '1week' }[interval]}&outputsize=${interval === '1h' ? 1000 : interval === '1d' ? 800 : 520}&order=asc&apikey=${key}`, { as: 'json' });
  if (j.status === 'error' || !Array.isArray(j.values)) throw new Error(j.message ? String(j.message).slice(0, 120) : 'no data');
  const tz = j.meta?.exchange_timezone || ex.tz;
  const rows = j.values.map((v) => ({ t: Math.floor(Date.parse(v.datetime.length <= 10 ? v.datetime + 'T12:00:00Z' : v.datetime.replace(' ', 'T') + 'Z') / 1000), o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: +(v.volume || 0) }));
  return { source: 'Twelve Data', meta: meta(symbol, interval, { exchange: j.meta?.exchange || ex.name, currency: j.meta?.currency || ex.currency, quoteType: j.meta?.type === 'ETF' ? 'ETF' : '', tz }), candles: clean(rows) };
}

// Stooq covers several non-US markets for free (daily/weekly)
export async function stooqIntl(symbol, interval) {
  if (interval === '1h') throw new Error('no intraday');
  const ex = exchangeOf(symbol);
  if (!ex.stooq) throw new Error(`${ex.short} not on Stooq`);
  const csv = await http('stooq', `https://stooq.com/q/d/l/?s=${encodeURIComponent(ex.base.toLowerCase())}.${ex.stooq}&i=${interval === '1wk' ? 'w' : 'd'}`, { as: 'text', timeout: 20_000 });
  if (typeof csv !== 'string' || !csv.startsWith('Date')) throw new Error(/apikey|captcha/i.test(String(csv)) ? 'requires an API key now' : 'no data');
  const rows = csv.trim().split('\n').slice(1).slice(interval === '1wk' ? -520 : -760).map((ln) => { const [d, o, h, l, c, v] = ln.split(','); return { t: Math.floor(Date.parse(d + 'T12:00:00Z') / 1000), o: +o, h: +h, l: +l, c: +c, v: +(v || 0) }; });
  return { source: 'Stooq', meta: meta(symbol, interval, { exchange: ex.name, currency: ex.currency }), candles: clean(rows) };
}

// ---------- Crypto ----------
export async function alpacaCrypto(symbol, interval) {
  const tf = { '1h': '1Hour', '1d': '1Day', '1wk': '1Week' }[interval];
  const pair = `${cryptoBase(symbol)}/USD`;
  const start = new Date((nowSec() - SPAN[interval]) * 1000).toISOString();
  const rows = []; let token = '';
  for (let page = 0; page < 5; page++) {
    const j = await http('alpaca-crypto', `https://data.alpaca.markets/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(pair)}&timeframe=${tf}&start=${encodeURIComponent(start)}&limit=10000${token ? `&page_token=${encodeURIComponent(token)}` : ''}`, { headers: alpacaKeys() || {}, as: 'json' });
    for (const b of j.bars?.[pair] || []) rows.push({ t: Math.floor(Date.parse(b.t) / 1000), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    token = j.next_page_token; if (!token) break;
  }
  return { source: 'Alpaca crypto', meta: meta(symbol, interval, { name: `${cryptoBase(symbol)} / USD`, exchange: 'Alpaca', quoteType: 'CRYPTOCURRENCY', assetClass: 'crypto' }), candles: clean(rows) };
}

// Coinbase Exchange public candles: [time, low, high, open, close, volume], max 300 per request
export async function coinbase(symbol, interval) {
  const g = interval === '1h' ? 3600 : 86400;
  const product = `${cryptoBase(symbol)}-USD`;
  const end = nowSec(), start = end - SPAN[interval];
  const rows = [];
  for (let to = end; to > start && rows.length < 4000; to -= 300 * g) {
    const from = Math.max(start, to - 300 * g);
    const j = await http('coinbase', `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${g}&start=${new Date(from * 1000).toISOString()}&end=${new Date(to * 1000).toISOString()}`, { as: 'json', timeout: 10_000 });
    if (!Array.isArray(j)) throw new Error(j?.message || 'no data');
    if (!j.length) break;
    for (const k of j) rows.push({ t: k[0], l: +k[1], h: +k[2], o: +k[3], c: +k[4], v: +k[5] });
  }
  const daily = clean(rows);
  return { source: 'Coinbase', meta: meta(symbol, interval, { name: `${cryptoBase(symbol)} / USD`, exchange: 'Coinbase', quoteType: 'CRYPTOCURRENCY', assetClass: 'crypto' }), candles: interval === '1wk' ? toWeekly(daily) : daily };
}

// Kraken public OHLC: last 720 bars, [time, open, high, low, close, vwap, volume, count]
const KRAKEN_ALIAS = { BTC: 'XBT', DOGE: 'XDG' };
export async function kraken(symbol, interval) {
  const base = cryptoBase(symbol);
  const j = await http('kraken', `https://api.kraken.com/0/public/OHLC?pair=${KRAKEN_ALIAS[base] || base}USD&interval=${{ '1h': 60, '1d': 1440, '1wk': 10080 }[interval]}`, { as: 'json', timeout: 10_000 });
  if (j.error?.length) throw new Error(j.error.join(', '));
  const key = Object.keys(j.result || {}).find((k) => k !== 'last');
  if (!key) throw new Error('no data');
  const rows = j.result[key].slice(0, -1).map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] })); // drop the still-forming bar
  return { source: 'Kraken', meta: meta(symbol, interval, { name: `${base} / USD`, exchange: 'Kraken', quoteType: 'CRYPTOCURRENCY', assetClass: 'crypto' }), candles: clean(rows) };
}

export async function binanceUS(symbol, interval) {
  const base = cryptoBase(symbol);
  const rows = await http('binance-us', `https://api.binance.us/api/v3/klines?symbol=${base}USDT&interval=${{ '1h': '1h', '1d': '1d', '1wk': '1w' }[interval]}&limit=1000`, { as: 'json', timeout: 10_000 });
  if (!Array.isArray(rows) || !rows.length) throw new Error('no data');
  return { source: 'Binance.US', meta: meta(symbol, interval, { name: `${base} / USDT`, exchange: 'Binance.US', quoteType: 'CRYPTOCURRENCY', assetClass: 'crypto' }), candles: clean(rows.map((k) => ({ t: Math.floor(k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))) };
}

export function chainFor(isCrypto, intl = false) {
  const has = (k) => () => !!env(k);
  const stock = [['alpaca', alpacaStock, () => !!alpacaKeys()], ['tiingo', tiingoStock, has('TIINGO_API_KEY')], ['twelvedata', twelveData, has('TWELVEDATA_API_KEY')], ['eodhd', eodhd, has('EODHD_API_KEY')], ['yahoo', yahoo], ['nasdaq', nasdaq], ['stooq', stooq]];
  const world = [['eodhd', eodhd, has('EODHD_API_KEY')], ['twelvedata', twelveData, has('TWELVEDATA_API_KEY')], ['yahoo', yahoo], ['stooq', stooqIntl]];
  const crypto = [['alpaca-crypto', alpacaCrypto], ['coinbase', coinbase], ['kraken', kraken], ['yahoo', yahoo], ['binance-us', binanceUS]];
  return (isCrypto ? crypto : intl ? world : stock).filter(([, , on]) => !on || on());
}
export const _test = { breaker, trip, toWeekly, clean };

// Boot-time self-test: one request per source, results written to the server log
export async function selfTest(log = console.log) {
  const probes = [['stock', 'AAPL', chainFor(false)], ['world', 'VOD.L', chainFor(false, true)], ['crypto', 'BTC-USD', chainFor(true)]];
  for (const [kind, sym, chain] of probes) {
    for (const [name, fn] of chain) {
      const t = Date.now();
      try { const r = await fn(sym, '1d', () => 'stock'); log(`[selftest] ${kind} ${sym} via ${name}: OK ${r.candles.length} bars, last close ${r.candles.at(-1)?.c} (${Date.now() - t}ms)`); }
      catch (e) { log(`[selftest] ${kind} ${sym} via ${name}: FAIL ${String(e.message).slice(0, 220)} (${Date.now() - t}ms)`); }
    }
  }
  breaker.clear(); // don't let the probe itself put sources on cool-down
}
