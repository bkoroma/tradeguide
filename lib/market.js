// TradeGuide — server-side market data. No API keys required.
// Primary: Yahoo Finance chart API (stocks, ETFs, crypto).
// Fallbacks: Binance.US klines (crypto), Stooq daily CSV (US stocks).
// Node 18+ (global fetch).

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const SYMBOL_RE = /^[A-Za-z0-9.\-=^]{1,20}$/;
const INTERVALS = {
  '1h': { yInterval: '1h', range: '6mo', binance: '1h' },
  '1d': { yInterval: '1d', range: '3y', binance: '1d' },
  '1wk': { yInterval: '1wk', range: '10y', binance: '1w' },
};

const cache = new Map(); // key -> { exp, value }
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const p = fn().then((v) => { cache.set(key, { exp: Date.now() + ttlMs, value: Promise.resolve(v) }); return v; });
  p.catch(() => cache.delete(key));
  cache.set(key, { exp: Date.now() + ttlMs, value: p });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return p;
}

async function getJSON(url, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? r.json() : r.text();
  } finally { clearTimeout(t); }
}

export function validate(symbol, interval) {
  if (!symbol || !SYMBOL_RE.test(symbol)) { const e = new Error('Invalid symbol'); e.status = 400; throw e; }
  if (!INTERVALS[interval]) { const e = new Error('Invalid interval (use 1h, 1d or 1wk)'); e.status = 400; throw e; }
}

export function assetClassOf(symbol, quoteType) {
  if (quoteType === 'CRYPTOCURRENCY' || /-(USD|USDT|EUR|GBP|BTC|ETH)$/i.test(symbol)) return 'crypto';
  if (quoteType === 'ETF') return 'etf';
  return 'stock';
}

async function yahooChart(symbol, interval) {
  const cfg = INTERVALS[interval];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${cfg.yInterval}&range=${cfg.range}&includePrePost=false&events=div,split`;
  const j = await getJSON(url);
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(j?.chart?.error?.description || 'No data');
  const q = res.indicators?.quote?.[0] || {};
  const ts = res.timestamp || [];
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if ([o, h, l, c].some((x) => x == null || !isFinite(x))) continue;
    candles.push({ t: ts[i], o, h, l, c, v: q.volume?.[i] ?? 0 });
  }
  const m = res.meta || {};
  return {
    source: 'Yahoo Finance',
    meta: {
      symbol: m.symbol || symbol, name: m.longName || m.shortName || m.symbol || symbol,
      currency: m.currency || 'USD', exchange: m.fullExchangeName || m.exchangeName || '',
      quoteType: m.instrumentType || '', assetClass: assetClassOf(symbol, m.instrumentType),
      marketPrice: m.regularMarketPrice ?? null, interval,
    },
    candles,
  };
}

async function binanceChart(symbol, interval) {
  const base = symbol.toUpperCase().replace(/-(USD|USDT)$/, '');
  const url = `https://api.binance.us/api/v3/klines?symbol=${base}USDT&interval=${INTERVALS[interval].binance}&limit=1000`;
  const rows = await getJSON(url);
  if (!Array.isArray(rows) || !rows.length) throw new Error('No Binance data');
  return {
    source: 'Binance.US',
    meta: { symbol: symbol.toUpperCase(), name: `${base} / USDT`, currency: 'USD', exchange: 'Binance.US', quoteType: 'CRYPTOCURRENCY', assetClass: 'crypto', interval },
    candles: rows.map((k) => ({ t: Math.floor(k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })),
  };
}

async function stooqChart(symbol, interval) {
  if (interval === '1h') throw new Error('Stooq has no intraday data');
  const s = symbol.toLowerCase().replace(/\./g, '-') + (symbol.includes('.') ? '' : '.us');
  const csv = await getJSON(`https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=${interval === '1wk' ? 'w' : 'd'}`);
  if (typeof csv !== 'string' || !csv.startsWith('Date')) throw new Error('No Stooq data');
  const lines = csv.trim().split('\n').slice(1);
  const keep = interval === '1wk' ? 520 : 760;
  const candles = lines.slice(-keep).map((ln) => {
    const [d, o, h, l, c, v] = ln.split(',');
    return { t: Math.floor(Date.parse(d + 'T21:00:00Z') / 1000), o: +o, h: +h, l: +l, c: +c, v: +(v || 0) };
  }).filter((x) => isFinite(x.c));
  return { source: 'Stooq', meta: { symbol: symbol.toUpperCase(), name: symbol.toUpperCase(), currency: 'USD', exchange: 'US', quoteType: '', assetClass: 'stock', interval }, candles };
}

export async function getChart(symbol, interval = '1d') {
  validate(symbol, interval);
  if (process.env.MARKET_DEMO === '1') { const { demoChart } = await import('../public/js/data.js'); return demoChart(symbol, interval); } // synthetic data for offline testing
  const ttl = interval === '1h' ? 60_000 : 5 * 60_000;
  return cached(`c:${symbol.toUpperCase()}:${interval}`, ttl, async () => {
    const errors = [];
    const isCrypto = assetClassOf(symbol) === 'crypto';
    const chain = isCrypto ? [yahooChart, binanceChart] : [yahooChart, stooqChart];
    for (const fn of chain) {
      try {
        const r = await fn(symbol, interval);
        if (r.candles.length >= 30) return r;
        errors.push(`${fn.name}: only ${r.candles.length} bars`);
      } catch (e) { errors.push(`${fn.name}: ${e.message}`); }
    }
    const e = new Error(`No market data for ${symbol} (${errors.join('; ')})`);
    e.status = 502;
    throw e;
  });
}

// Yahoo predefined screener — used by the bot to discover active names beyond the fixed list
export function discover(count = 15) {
  return cached(`d:${count}`, 15 * 60_000, async () => {
    const out = [];
    for (const id of ['most_actives', 'day_gainers']) {
      try {
        const j = await getJSON(`https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${id}&count=${count}`);
        for (const q of j?.finance?.result?.[0]?.quotes || []) {
          if (q.symbol && SYMBOL_RE.test(q.symbol) && (q.regularMarketPrice ?? 0) >= 5 && (q.averageDailyVolume3Month ?? q.regularMarketVolume ?? 0) >= 1e6) out.push(q.symbol);
        }
      } catch { /* best effort */ }
    }
    return [...new Set(out)].slice(0, count);
  });
}

export function search(q) {
  q = String(q || '').trim().slice(0, 40);
  if (!q) return Promise.resolve([]);
  return cached(`s:${q.toLowerCase()}`, 10 * 60_000, async () => {
    const j = await getJSON(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`);
    return (j?.quotes || [])
      .filter((x) => ['EQUITY', 'ETF', 'CRYPTOCURRENCY', 'INDEX'].includes(x.quoteType) && x.symbol)
      .map((x) => ({ symbol: x.symbol, name: x.shortname || x.longname || x.symbol, type: x.quoteType, exchange: x.exchDisp || x.exchange || '', assetClass: assetClassOf(x.symbol, x.quoteType) }));
  });
}

import * as brokers from './brokers.js';

// Shared HTTP handler logic → { status, body, headers }
// ctx = { headers: lower-cased header object, ip }
export async function handleApi(pathname, params, ctx = {}) {
  if (pathname.startsWith('/api/broker/')) return handleBroker(pathname.slice('/api/broker/'.length), params, ctx);
  if (pathname.startsWith('/api/bot/')) return handleBot(pathname.slice('/api/bot/'.length), params, ctx);
  if (pathname.startsWith('/api/live/')) return handleLive(pathname.slice('/api/live/'.length), params, ctx);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' };
  try {
    if (pathname.endsWith('/chart')) {
      const data = await getChart(params.get('symbol'), params.get('interval') || '1d');
      return { status: 200, headers, body: JSON.stringify(data) };
    }
    if (pathname.endsWith('/search')) {
      return { status: 200, headers, body: JSON.stringify(await search(params.get('q'))) };
    }
    if (pathname.endsWith('/health')) return { status: 200, headers, body: JSON.stringify({ ok: true, time: Date.now() }) };
    return { status: 404, headers, body: JSON.stringify({ error: 'Not found' }) };
  } catch (e) {
    return { status: e.status || 500, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: e.message }) };
  }
}

let lastRefresh = 0;
async function handleBroker(action, params, ctx) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, private' };
  const out = (status, obj) => ({ status, headers, body: JSON.stringify(obj) });
  const gate = brokers.checkAccess(ctx.headers || {}, ctx.ip || '');
  if (!gate.ok) return out(gate.status, { error: gate.error });
  try {
    if (action === 'status') return out(200, { providers: brokers.status() });
    if (action === 'portfolio') return out(200, await brokers.portfolio());
    if (action === 'connect') {
      const b = String(params.get('broker') || '');
      if (b && !/^[A-Z0-9_-]{2,40}$/i.test(b)) return out(400, { error: 'Invalid brokerage' });
      return out(200, { url: await brokers.connectUrl(String(params.get('provider') || ''), b) });
    }
    if (action === 'brokerages') return out(200, { brokerages: await brokers.brokerages() });
    if (action === 'refresh') {
      if (Date.now() - lastRefresh < 15 * 60_000) return out(429, { error: 'Broker refresh is limited to once per 15 minutes.' });
      lastRefresh = Date.now();
      return out(200, { results: await brokers.refreshConnections() });
    }
    return out(404, { error: 'Not found' });
  } catch (e) {
    return out(e.status || 502, { error: e.message });
  }
}

let lastManualRun = 0;
async function handleBot(action, params, ctx) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, private' };
  const out = (status, obj) => ({ status, headers, body: JSON.stringify(obj) });
  const gate = brokers.checkAccess(ctx.headers || {}, ctx.ip || '');
  if (!gate.ok) return out(gate.status, { error: gate.error });
  const bot = await import('./bot.js');
  try {
    if (action === 'status') return out(200, await bot.botStatus());
    if (action === 'run') {
      if (Date.now() - lastManualRun < 120_000) return out(429, { error: 'Please wait 2 minutes between manual scans.' });
      lastManualRun = Date.now();
      const classes = params.get('all') === '1' ? ['stock', 'crypto'] : undefined;
      return out(200, await bot.runBot({ classes }));
    }
    if (action === 'test') return out(200, { results: await bot.sendTest() });
    return out(404, { error: 'Not found' });
  } catch (e) {
    return out(e.status || 500, { error: e.message });
  }
}

let ordersCache = null;
async function handleLive(action, params, ctx) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, private' };
  const out = (status, obj) => ({ status, headers, body: JSON.stringify(obj) });
  const gate = brokers.checkAccess(ctx.headers || {}, ctx.ip || '');
  if (!gate.ok) return out(gate.status, { error: gate.error });
  const live = await import('./live.js');
  const { makeTicket } = await import('./keys.js');
  try {
    if (action === 'ticket') return out(200, { ticket: makeTicket(process.env.APP_ACCESS_TOKEN.trim(), 60), streaming: process.env.LIVE_SSE !== '0' });
    if (action === 'status') return out(200, { ...live.liveStatus(), events: live.recentEvents(100), providers: brokers.status() });
    if (action === 'orders') { // on-demand pull — used by serverless hosts and as the stream fallback
      if (!ordersCache || Date.now() - ordersCache.at > 30_000) ordersCache = { at: Date.now(), p: brokers.recentOrders() };
      const r = await ordersCache.p;
      return out(200, { ...r, providers: brokers.status() });
    }
    return out(404, { error: 'Not found' });
  } catch (e) {
    ordersCache = null;
    return out(e.status || 502, { error: e.message });
  }
}
