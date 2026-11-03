// TradeGuide — server-side market data, API router. Sources and failover live in ./sources.js.
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

import { chainFor, sourceHealth, http } from './sources.js';
import { loadUniverse, searchUniverse, peek, universeStats, browse } from './universe.js';

// Last good result per chart, served (marked stale) if every source fails
const lastGood = new Map();

export async function getChart(symbol, interval = '1d') {
  validate(symbol, interval);
  if (process.env.MARKET_DEMO === '1') { const { demoChart } = await import('../public/js/data.js'); return demoChart(symbol, interval); } // synthetic data for offline testing
  const key = `c:${symbol.toUpperCase()}:${interval}`;
  const ttl = interval === '1h' ? 2 * 60_000 : 10 * 60_000;
  return cached(key, ttl, async () => {
    const errors = [];
    const isCrypto = assetClassOf(symbol) === 'crypto';
    for (const [name, fn] of chainFor(isCrypto)) {
      try {
        const r = await fn(symbol, interval, assetClassOf);
        if (r.candles.length >= 30) {
          const u = peek(symbol);
          if (u) { // official directory: real name + ETF flag, whatever source served the candles
            if (!r.meta.name || r.meta.name === r.meta.symbol) r.meta.name = u.name;
            if (u.assetClass === 'etf') { r.meta.quoteType = 'ETF'; r.meta.assetClass = 'etf'; }
            if (!r.meta.exchange) r.meta.exchange = u.exchange;
          }
          r.meta.assetClass ||= assetClassOf(symbol, r.meta.quoteType);
          r.meta.interval = interval;
          lastGood.set(key, { at: Date.now(), r });
          if (lastGood.size > 400) lastGood.delete(lastGood.keys().next().value);
          return r;
        }
        errors.push(`${name}: only ${r.candles.length} bars`);
      } catch (e) { errors.push(`${name}: ${e.message}`); }
    }
    const stale = lastGood.get(key);
    if (stale && Date.now() - stale.at < 24 * 3600e3) return { ...stale.r, stale: true, staleSince: stale.at };
    const e = new Error(`No market data for ${symbol} (${errors.join('; ')})`);
    e.status = 502;
    throw e;
  });
}

export function marketHealth() {
  const has = (k) => !!(process.env[k] || '').trim();
  return {
    keys: { alpaca: has('ALPACA_DATA_KEY_ID') || has('ALPACA_KEY_ID'), tiingo: has('TIINGO_API_KEY') },
    stockChain: chainFor(false).map(([n]) => n), cryptoChain: chainFor(true).map(([n]) => n),
    sources: sourceHealth(),
  };
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

// Search: the full official US + crypto universe first; Yahoo adds international listings when reachable
export function search(q, cls = '') {
  q = String(q || '').trim().slice(0, 40);
  if (!q) return Promise.resolve([]);
  return cached(`s:${cls}:${q.toLowerCase()}`, 10 * 60_000, async () => {
    const local = await searchUniverse(q, { cls, limit: 15 });
    if (local.length >= 8 || cls) return local;
    try {
      const j = await http('yahoo-search', `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`, { as: 'json', timeout: 6000 });
      const seen = new Set(local.map((x) => x.symbol));
      const extra = (j?.quotes || [])
        .filter((x) => ['EQUITY', 'ETF', 'CRYPTOCURRENCY'].includes(x.quoteType) && x.symbol && !seen.has(x.symbol))
        .map((x) => ({ symbol: x.symbol, name: x.shortname || x.longname || x.symbol, type: x.quoteType, exchange: x.exchDisp || x.exchange || '', assetClass: assetClassOf(x.symbol, x.quoteType) }));
      return [...local, ...extra].slice(0, 15);
    } catch { return local; }
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
      const cls = ['stock', 'etf', 'crypto'].includes(params.get('class')) ? params.get('class') : '';
      return { status: 200, headers, body: JSON.stringify(await search(params.get('q'), cls)) };
    }
    if (pathname.endsWith('/universe')) {
      const cls = ['stock', 'etf', 'crypto'].includes(params.get('class')) ? params.get('class') : 'etf';
      const offset = Math.max(0, parseInt(params.get('offset') || '0', 10) || 0), limit = Math.max(1, Math.min(500, parseInt(params.get('limit') || '100', 10) || 100));
      return { status: 200, headers: { ...headers, 'Cache-Control': 'public, max-age=3600' }, body: JSON.stringify({ ...(await browse({ cls, offset, limit })), stats: universeStats() }) };
    }
    if (pathname.endsWith('/health')) return { status: 200, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ ok: true, time: Date.now(), market: marketHealth(), universe: universeStats() }) };
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
