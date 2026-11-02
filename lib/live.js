// TradeGuide — live trade hub. READ-ONLY: watches your brokerage orders and fills in (near) real time.
//
//   Alpaca      WebSocket trade_updates             → instant push
//   Coinbase    Advanced Trade WebSocket "user"      → instant push
//   SnapTrade   TRADE_DETECTION webhooks             → seconds (Webull, tastytrade, Alpaca…) to 5 min (Robinhood, Schwab, E*TRADE)
//               + recentOrders poll (realtime endpoint, every SNAPTRADE_POLL_MIN, default 10)
//   Robinhood   Crypto Trading API orders poll       → every ROBINHOOD_POLL_SEC (default 20)
//
// Browser gets events over Server-Sent Events (/api/live/stream). Needs a long-running Node host
// (Render, Railway, Fly, VPS, your PC). Netlify/Vercel: webhooks + on-demand polling still work.
import { EventEmitter } from 'node:events';
import * as brokers from './brokers.js';
import { coinbaseJwt, verifySnaptradeSignature, checkTicket } from './keys.js';
import { notify, configuredChannels } from './notify.js';
import { getChart } from './market.js';
import { analyze, fmtPx } from '../public/js/engine.js';
import { classify } from '../public/js/assets.js';

const env = (k) => (process.env[k] || '').trim();
export const hub = new EventEmitter();
hub.setMaxListeners(200);

const events = [];            // newest first, capped
const seen = new Map();       // dedupe key -> time
const sources = {};           // id -> { mode, state, detail, lastEventAt, since }
let started = false;
const stoppers = [];
const unref = (t) => (t?.unref?.(), t); // never keep the process alive just for timers

function setSource(id, patch) { sources[id] = { ...(sources[id] || {}), ...patch, at: Date.now() }; hub.emit('status', liveStatus()); }
export function liveStatus() { return { started, sources, clients: hub.listenerCount('event'), channels: configuredChannels(), notifyFills: env('LIVE_NOTIFY') !== '0' }; }
export const recentEvents = (n = 100) => events.slice(0, n);

// ---------- Ingest ----------
export async function ingest(order, { via, snapshot = false } = {}) {
  if (!order?.id) return null;
  const key = `${order.provider}:${order.accountId || ''}:${order.id}:${order.status}:${order.filledQty ?? ''}`;
  if (seen.has(key)) return null;
  seen.set(key, Date.now());
  if (seen.size > 5000) for (const [k, t] of seen) { if (Date.now() - t > 3 * 86400e3) seen.delete(k); if (seen.size < 4000) break; }
  const ev = { ...order, via, snapshot, receivedAt: Date.now() };
  ev.cls = order.assetClass === 'option' ? 'option' : classify(order.chartSymbol || order.symbol, order.assetClass).cls;
  events.unshift(ev); if (events.length > 300) events.length = 300;
  if (sources[order.provider]) sources[order.provider].lastEventAt = Date.now();
  hub.emit('event', ev);
  if (!snapshot && (ev.status === 'filled' || ev.status === 'partial')) tradeCheck(ev).catch(() => {});
  return ev;
}

// TradeGuide's opinion on a fill you just made, pushed to your phone and to the open app
async function tradeCheck(ev) {
  let check = null;
  if (ev.chartSymbol && ev.cls !== 'option') {
    try {
      const d = await getChart(ev.chartSymbol, '1d');
      const r = analyze(d.candles, { ...d.meta, interval: '1d' });
      const s = r.signal, against = (ev.side === 'BUY' && s.action === 'SELL') || (ev.side === 'SELL' && s.action === 'BUY');
      const stop = ev.side === 'BUY' ? r.plan.stop : null;
      check = { signal: s.label, tone: s.tone, score: Math.round(s.score), risk: r.risk.score, riskLevel: r.risk.level, against,
        text: `${against ? '⚠️ Goes against' : s.action === 'WAIT' ? 'No clear signal for' : '✓ In line with'} the current signal (${s.label}, ${Math.round(s.score)}). Risk ${r.risk.score}/10.${stop ? ` Suggested stop ${fmtPx(stop)}.` : ''}` };
    } catch { /* chart unavailable */ }
  }
  ev.check = check;
  hub.emit('check', { key: `${ev.provider}:${ev.id}:${ev.status}`, id: ev.id, provider: ev.provider, check });
  if (env('LIVE_NOTIFY') === '0' || !configuredChannels().length) return;
  const C = classify(ev.chartSymbol || ev.symbol, ev.assetClass);
  const tag = ev.cls === 'option' ? 'OPTION' : C.profile.short;
  const qty = ev.filledQty ?? ev.qty;
  await notify({
    title: `🧾 ${ev.status === 'partial' ? 'PARTIAL FILL' : 'FILLED'} · ${tag} · ${ev.side} ${qty ?? ''} ${ev.symbol}${ev.price ? ` @ ${fmtPx(ev.price)}` : ''}`,
    body: `${ev.broker}${ev.account ? ` · ${ev.account}` : ''} · via ${ev.via}\n${check ? `TradeGuide check: ${check.text}` : 'TradeGuide check unavailable for this instrument.'}\n\nRead-only alert — TradeGuide did not place this trade.`,
    url: env('APP_URL') && ev.chartSymbol ? `${env('APP_URL').replace(/\/$/, '')}/#/${encodeURIComponent(ev.chartSymbol)}` : env('APP_URL'),
    tags: ev.side === 'BUY' ? 'receipt,green_circle' : 'receipt,red_circle', priority: '4', data: { symbol: ev.symbol, action: `FILL_${ev.side}` },
  });
}

// ---------- WebSocket helper (Node 22 global WebSocket, else the `ws` package) ----------
async function openSocket(url) {
  if (globalThis.WebSocket) { const ws = new globalThis.WebSocket(url); ws.binaryType = 'arraybuffer'; return ws; }
  const { default: WS } = await import('ws');
  return new WS(url);
}
const on = (ws, name, fn) => (ws.addEventListener ? ws.addEventListener(name, fn) : ws.on(name, (...a) => fn(name === 'message' ? { data: a[0] } : a[0])));
const text = (data) => (typeof data === 'string' ? data : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString('utf8'));

function supervised(id, mode, connect) {
  let delay = 1000, stopped = false, current = null;
  const loop = async () => {
    if (stopped) return;
    setSource(id, { mode, state: 'connecting', detail: '' });
    try {
      current = await connect({
        ok: (detail) => { delay = 1000; setSource(id, { state: 'live', detail, since: Date.now() }); },
        fail: (detail) => setSource(id, { state: 'error', detail }),
      });
      await current.closed;
    } catch (e) { setSource(id, { state: 'error', detail: e.message }); }
    if (stopped) return;
    setSource(id, { state: 'reconnecting', detail: `retry in ${Math.round(delay / 1000)}s` });
    unref(setTimeout(loop, delay)); delay = Math.min(delay * 2, 60_000);
  };
  loop();
  return () => { stopped = true; current?.close?.(); };
}

// ---------- Alpaca: trade_updates stream ----------
function startAlpaca() {
  const paper = env('ALPACA_PAPER').toLowerCase() !== 'false';
  const url = env('ALPACA_STREAM_URL') || (paper ? 'wss://paper-api.alpaca.markets/stream' : 'wss://api.alpaca.markets/stream');
  const ctx = { broker: paper ? 'Alpaca (paper)' : 'Alpaca', account: paper ? 'Paper account' : 'Brokerage' };
  return supervised('alpaca', 'stream', async ({ ok, fail }) => {
    // snapshot of recent orders so the feed isn't empty, then live updates
    try { for (const o of (await brokers.provider('alpaca').recentOrders()).slice().reverse()) await ingest(o, { via: 'snapshot', snapshot: true }); } catch (e) { fail(`snapshot: ${e.message}`); }
    const ws = await openSocket(url);
    let resolve; const closed = new Promise((r) => (resolve = r));
    on(ws, 'open', () => ws.send(JSON.stringify({ action: 'auth', key: env('ALPACA_KEY_ID'), secret: env('ALPACA_SECRET_KEY') })));
    on(ws, 'message', (m) => {
      let j; try { j = JSON.parse(text(m.data)); } catch { return; }
      if (j.stream === 'authorization') {
        if (j.data?.status === 'authorized') ws.send(JSON.stringify({ action: 'listen', data: { streams: ['trade_updates'] } }));
        else { fail('unauthorized — check ALPACA keys / ALPACA_PAPER'); ws.close(); }
      } else if (j.stream === 'listening') ok(`trade_updates (${paper ? 'paper' : 'live'})`);
      else if (j.stream === 'trade_updates' && j.data?.order) {
        const o = brokers.normalizeOrder('alpaca', j.data.order, ctx);
        if (j.data.event === 'fill' || j.data.event === 'partial_fill') { o.status = j.data.event === 'fill' ? 'filled' : 'partial'; if (j.data.price) o.lastFillPrice = +j.data.price; if (j.data.qty) o.lastFillQty = +j.data.qty; }
        ingest(o, { via: 'stream' });
      }
    });
    on(ws, 'close', () => resolve()); on(ws, 'error', () => {});
    return { closed, close: () => ws.close() };
  });
}

// ---------- Coinbase: Advanced Trade "user" channel ----------
function startCoinbase() {
  const url = env('COINBASE_WS_URL') || 'wss://advanced-trade-ws-user.coinbase.com';
  const ctx = { broker: 'Coinbase', account: 'Advanced Trade' };
  return supervised('coinbase', 'stream', async ({ ok, fail }) => {
    try { for (const o of (await brokers.provider('coinbase').recentOrders()).slice().reverse()) await ingest(o, { via: 'snapshot', snapshot: true }); } catch (e) { fail(`snapshot: ${e.message}`); }
    const ws = await openSocket(url);
    let resolve; const closed = new Promise((r) => (resolve = r));
    let last = Date.now();
    const watchdog = unref(setInterval(() => { if (Date.now() - last > 90_000) { fail('no data for 90s — reconnecting'); ws.close(); } }, 15_000));
    const sub = (channel) => ws.send(JSON.stringify({ type: 'subscribe', channel, jwt: coinbaseJwt({ keyName: env('COINBASE_API_KEY_NAME'), secret: env('COINBASE_API_PRIVATE_KEY') }) }));
    on(ws, 'open', () => { sub('user'); sub('heartbeats'); });
    on(ws, 'message', (m) => {
      last = Date.now();
      let j; try { j = JSON.parse(text(m.data)); } catch { return; }
      if (j.type === 'error') { fail(j.message || 'error'); return; }
      if (j.channel === 'subscriptions') ok('user channel');
      if (j.channel !== 'user') return;
      for (const e of j.events || []) for (const o of e.orders || []) ingest(brokers.normalizeOrder('coinbase', o, ctx), { via: e.type === 'snapshot' ? 'snapshot' : 'stream', snapshot: e.type === 'snapshot' });
    });
    on(ws, 'close', () => { clearInterval(watchdog); resolve(); }); on(ws, 'error', () => {});
    return { closed, close: () => ws.close() };
  });
}

// ---------- Pollers ----------
function poller(id, everyMs, fetcher) {
  let first = true, timer = null;
  const tick = async () => {
    try {
      const orders = await fetcher();
      const errs = orders.filter((o) => o.error);
      for (const o of orders.filter((x) => !x.error).reverse()) await ingest(o, { via: first ? 'snapshot' : 'poll', snapshot: first });
      setSource(id, { mode: sources[id]?.mode || 'poll', state: errs.length ? 'error' : 'live', detail: errs.length ? errs[0].error : `polling every ${Math.round(everyMs / 1000)}s`, lastPollAt: Date.now() });
      first = false;
    } catch (e) { setSource(id, { state: 'error', detail: e.message }); }
    timer = unref(setTimeout(tick, everyMs));
  };
  setSource(id, { mode: sources[id]?.mode || 'poll', state: 'connecting', detail: '' });
  tick();
  return () => clearTimeout(timer);
}

// ---------- SnapTrade webhooks ----------
export async function handleSnaptradeWebhook(rawBody, headers = {}) {
  const sig = headers.signature || headers.Signature;
  if (!verifySnaptradeSignature(rawBody, sig, env('SNAPTRADE_CONSUMER_KEY'))) return { status: 401, body: '{"error":"bad signature"}' };
  let p; try { p = JSON.parse(rawBody); } catch { return { status: 400, body: '{"error":"bad json"}' }; }
  const ts = Date.parse(p.eventTimestamp || '');
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 300_000) return { status: 400, body: '{"error":"stale or missing eventTimestamp"}' };
  if (seen.has(`wh:${p.webhookId}`)) return { status: 200, body: '{"ok":true,"duplicate":true}' };
  seen.set(`wh:${p.webhookId}`, Date.now());
  setSource('snaptrade', { mode: 'webhook+poll', state: 'live', detail: `last webhook ${p.eventType}`, lastWebhookAt: Date.now(), lastWebhook: p.eventType });
  if (p.eventType === 'TRADE_DETECTION' || p.eventType === 'TRADE_UPDATE') {
    let accts = [];
    try { accts = await brokers.provider('snaptrade').accounts(); } catch { /* names optional */ }
    const a = accts.find((x) => x.id === p.accountId) || {};
    for (const o of p.details?.orders || []) {
      const ord = brokers.normalizeOrder('snaptrade', o, { accountId: p.accountId, broker: a.institution_name || 'Brokerage', account: a.name || a.institution_name || '' });
      ord.detectionLagSec = p.details?.detection_lag_seconds ?? null;
      await ingest(ord, { via: 'webhook' });
    }
  } else {
    const ev = { type: p.eventType, accountId: p.accountId || null, brokerageId: p.brokerageId || null, at: Date.now() };
    hub.emit('account', ev);
    if (['CONNECTION_BROKEN', 'CONNECTION_FAILED'].includes(p.eventType) && configuredChannels().length) {
      notify({ title: '⚠️ Brokerage connection needs attention', body: `SnapTrade reported ${p.eventType}. Open TradeGuide → Portfolio → Connect a brokerage to reconnect.`, url: env('APP_URL'), tags: 'warning', priority: '4' }).catch(() => {});
    }
  }
  return { status: 200, body: '{"ok":true}' };
}

// ---------- Start / stop ----------
export function startLive() {
  if (started) return liveStatus();
  started = true;
  const st = brokers.status();
  const on = (id) => st.some((p) => p.id === id && p.configured);
  if (on('alpaca')) stoppers.push(startAlpaca());
  if (on('coinbase')) stoppers.push(startCoinbase());
  if (on('snaptrade')) { sources.snaptrade = { mode: 'webhook+poll' }; stoppers.push(poller('snaptrade', Math.max(1, +(env('SNAPTRADE_POLL_MIN') || 10)) * 60_000, () => brokers.provider('snaptrade').recentOrders())); }
  if (on('robinhood')) stoppers.push(poller('robinhood', Math.max(5, +(env('ROBINHOOD_POLL_SEC') || 20)) * 1000, () => brokers.provider('robinhood').recentOrders()));
  if (on('demo')) startDemoFeed();
  return liveStatus();
}

// Sample feed for testing the UI end-to-end (BROKER_DEMO=1)
function startDemoFeed() {
  setSource('demo', { mode: 'stream', state: 'live', detail: 'sample fills every 45s' });
  const picks = [['AAPL', 'stock'], ['NVDA', 'stock'], ['SPY', 'etf'], ['BTC-USD', 'crypto'], ['SOL-USD', 'crypto'], ['TSLA', 'stock']];
  let n = 0;
  const fire = (snapshot) => {
    const [sym, ac] = picks[n % picks.length]; n++;
    const id = `demo-${Date.now()}-${n}`, sideV = n % 3 ? 'BUY' : 'SELL', qty = ac === 'crypto' ? 0.05 * n : 5 * ((n % 4) + 1);
    const base = { provider: 'demo', broker: 'Sample Broker', account: 'Individual', id, symbol: sym.replace('-USD', ''), chartSymbol: sym, assetClass: ac, side: sideV, type: 'market', qty, placedAt: new Date().toISOString() };
    ingest({ ...base, status: 'open', filledQty: 0, price: null, updatedAt: new Date().toISOString() }, { via: snapshot ? 'snapshot' : 'stream', snapshot });
    setTimeout(() => getChart(sym, '1d').then((d) => ingest({ ...base, status: 'filled', filledQty: qty, price: d.candles.at(-1).c, executedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { via: snapshot ? 'snapshot' : 'stream', snapshot })).catch(() => {}), snapshot ? 0 : 3000);
  };
  for (let k = 0; k < 4; k++) fire(true);
  const iv = unref(setInterval(() => fire(false), +(env('DEMO_FEED_SEC') || 45) * 1000));
  stoppers.push(() => clearInterval(iv));
}

// ---------- Server-Sent Events ----------
let clients = 0;
export function handleSSE(req, res, url) {
  if (!checkTicket(env('APP_ACCESS_TOKEN'), url.searchParams.get('ticket'))) { res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"bad or expired ticket"}'); return; }
  if (clients >= 25) { res.writeHead(503).end(); return; }
  clients++;
  if (!started) startLive();
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.write('retry: 5000\n\n');
  send('hello', { status: liveStatus(), events: recentEvents(60) });
  const onEvent = (e) => send('order', e), onStatus = (s) => send('status', s), onAcct = (a) => send('account', a), onCheck = (c) => send('check', c);
  hub.on('event', onEvent); hub.on('status', onStatus); hub.on('account', onAcct); hub.on('check', onCheck);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => { clients--; clearInterval(ping); hub.off('event', onEvent); hub.off('status', onStatus); hub.off('account', onAcct); hub.off('check', onCheck); });
}

export function stopLive() { while (stoppers.length) { try { stoppers.pop()(); } catch { /* */ } } started = false; }

export const _test = { reset() { events.length = 0; seen.clear(); for (const k of Object.keys(sources)) delete sources[k]; } };
