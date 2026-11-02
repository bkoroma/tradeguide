// TradeGuide — READ-ONLY brokerage connections.
// Keys live only in server environment variables; nothing here can place, change or cancel orders.
//
//   SnapTrade (Schwab, Fidelity, Robinhood, Webull, E*TRADE, Vanguard, IBKR, Coinbase, Kraken, …)
//     SNAPTRADE_CLIENT_ID, SNAPTRADE_CONSUMER_KEY
//     + SNAPTRADE_USER_ID, SNAPTRADE_USER_SECRET   (only for commercial keys; personal keys don't need them)
//   Alpaca (stocks + crypto)
//     ALPACA_KEY_ID, ALPACA_SECRET_KEY, ALPACA_PAPER=true|false
//   Sample portfolio for testing the UI:  BROKER_DEMO=1
//
// All broker endpoints require APP_ACCESS_TOKEN (your private access code).

import { createHash, timingSafeEqual } from 'node:crypto';
import { coinbaseJwt, robinhoodHeaders, ed25519FromBase64 } from './keys.js';

const env = (k) => (process.env[k] || '').trim();

// ---------- Access control ----------
const fails = new Map(); // ip -> { n, until }
export function checkAccess(headers = {}, ip = '') {
  const token = env('APP_ACCESS_TOKEN');
  if (!token) return { ok: false, status: 503, error: 'Broker features are disabled: set APP_ACCESS_TOKEN on the server (see README).' };
  if (token.length < 12) return { ok: false, status: 503, error: 'APP_ACCESS_TOKEN must be at least 12 characters.' };
  const f = fails.get(ip);
  if (f && f.until > Date.now()) return { ok: false, status: 429, error: 'Too many wrong access codes. Try again in 15 minutes.' };
  const auth = String(headers.authorization || headers.Authorization || '');
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = createHash('sha256').update(given).digest(), b = createHash('sha256').update(token).digest();
  if (given && timingSafeEqual(a, b)) { fails.delete(ip); return { ok: true }; }
  const n = (f?.n || 0) + 1;
  fails.set(ip, { n, until: n >= 8 ? Date.now() + 15 * 60_000 : 0 });
  if (fails.size > 2000) fails.clear();
  return { ok: false, status: 401, error: 'Wrong or missing access code.' };
}

// ---------- Helpers ----------
const num = (x) => (x == null || x === '' || !isFinite(+x) ? null : +x);
export const maskAcct = (s) => (s ? '••' + String(s).slice(-4) : '');
export function toChartSymbol(sym, isCrypto) {
  if (!sym) return null;
  let s = String(sym).toUpperCase().trim();
  if (isCrypto) {
    s = s.replace(/[-/]?(USDT|USDC|USD)$/, '');
    return `${s}-USD`;
  }
  return s.replace('/', '-').replace(/\.(?=[A-Z]$)/, '-'); // BRK.B → BRK-B (Yahoo style)
}
function position(p) {
  const qty = num(p.qty) ?? 0, price = num(p.price), avg = num(p.avgCost);
  const value = num(p.value) ?? (price != null ? qty * price : null);
  const cost = avg != null ? avg * qty : null;
  const pnl = num(p.pnl) ?? (value != null && cost != null ? value - cost : null);
  return { ...p, qty, price, avgCost: avg, value, cost, pnl, pnlPct: cost ? pnl / Math.abs(cost) : null };
}

const memoStore = new Map();
function memo(key, ttl, fn) {
  const h = memoStore.get(key);
  if (h && h.exp > Date.now()) return h.p;
  const p = fn(); memoStore.set(key, { exp: Date.now() + ttl, p }); p.catch(() => memoStore.delete(key));
  return p;
}

// ---------- Orders: one shape for every broker ----------
const STATUS = {
  filled: 'filled', executed: 'filled', fill: 'filled',
  partial: 'partial', partially_filled: 'partial', partial_fill: 'partial',
  canceled: 'canceled', cancelled: 'canceled', cancel_queued: 'canceling', pending_cancel: 'canceling',
  rejected: 'rejected', failed: 'rejected', expired: 'expired', done_for_day: 'expired',
  new: 'open', open: 'open', accepted: 'open', pending: 'open', pending_new: 'open', queued: 'open', triggered: 'open', activated: 'open', held: 'open', calculated: 'open', replaced: 'replaced',
};
export const normStatus = (s) => STATUS[String(s || '').toLowerCase()] || String(s || 'unknown').toLowerCase();
const side = (s) => { const x = String(s || '').toUpperCase(); return x.startsWith('BUY') ? 'BUY' : x.startsWith('SELL') ? 'SELL' : x || '—'; };

export function normalizeOrder(provider, o, ctx = {}) {
  let r;
  if (provider === 'snaptrade') {
    const sym = o.universal_symbol?.symbol || o.option_symbol?.ticker || o.symbol || '';
    const isCrypto = String(o.universal_symbol?.type?.code || '').toLowerCase().includes('crypto');
    r = { id: o.brokerage_order_id, symbol: sym, chartSymbol: o.option_symbol ? null : toChartSymbol(sym, isCrypto), assetClass: o.option_symbol ? 'option' : isCrypto ? 'crypto' : 'stock',
      side: side(o.action), rawSide: o.action, type: o.order_type, status: normStatus(o.status), qty: num(o.total_quantity), filledQty: num(o.filled_quantity), price: num(o.execution_price) ?? num(o.limit_price), limitPrice: num(o.limit_price), stopPrice: num(o.stop_price),
      placedAt: o.time_placed || null, executedAt: o.time_executed || null, updatedAt: o.time_updated || o.time_executed || o.time_placed || null };
  } else if (provider === 'alpaca') {
    const isCrypto = o.asset_class === 'crypto';
    r = { id: o.id, symbol: o.symbol, chartSymbol: toChartSymbol(o.symbol, isCrypto), assetClass: isCrypto ? 'crypto' : o.asset_class === 'us_option' ? 'option' : 'stock',
      side: side(o.side), type: o.type || o.order_type, status: normStatus(o.status), qty: num(o.qty) ?? (num(o.notional) && num(o.filled_avg_price) ? num(o.notional) / num(o.filled_avg_price) : null), filledQty: num(o.filled_qty), price: num(o.filled_avg_price) ?? num(o.limit_price), limitPrice: num(o.limit_price), stopPrice: num(o.stop_price),
      placedAt: o.submitted_at || o.created_at || null, executedAt: o.filled_at || null, updatedAt: o.updated_at || o.filled_at || o.submitted_at || null };
  } else if (provider === 'coinbase') {
    const sym = o.product_id || '';
    const filled = num(o.filled_size ?? o.cumulative_quantity);
    const leaves = num(o.leaves_quantity);
    r = { id: o.order_id, symbol: sym, chartSymbol: toChartSymbol(sym, true), assetClass: 'crypto',
      side: side(o.side || o.order_side), type: o.order_type, status: normStatus(o.status), qty: leaves != null && filled != null ? filled + leaves : filled, filledQty: filled, price: num(o.average_filled_price ?? o.avg_price),
      placedAt: o.created_time || o.creation_time || null, executedAt: o.last_fill_time || null, updatedAt: o.last_fill_time || o.created_time || o.creation_time || null };
  } else if (provider === 'robinhood') {
    const cfg = o.market_order_config || o.limit_order_config || o.stop_loss_order_config || o.stop_limit_order_config || {};
    r = { id: o.id, symbol: o.symbol, chartSymbol: toChartSymbol(o.symbol, true), assetClass: 'crypto',
      side: side(o.side), type: o.type, status: normStatus(o.state), qty: num(cfg.asset_quantity), filledQty: num(o.filled_asset_quantity), price: num(o.average_price) ?? num(cfg.limit_price),
      placedAt: o.created_at || null, executedAt: o.state === 'filled' ? o.updated_at : null, updatedAt: o.updated_at || o.created_at || null };
  } else r = { ...o };
  if (r.status === 'filled' && r.filledQty == null) r.filledQty = r.qty;
  return { provider, broker: ctx.broker || provider, account: ctx.account || '', accountId: ctx.accountId || null, ...r };
}

// ---------- Providers ----------
const providers = {
  snaptrade: {
    name: 'SnapTrade (most brokers)',
    configured: () => !!(env('SNAPTRADE_CLIENT_ID') && env('SNAPTRADE_CONSUMER_KEY')),
    async client() {
      const { Snaptrade, SnaptradeAuth } = await import('snaptrade-typescript-sdk');
      const keys = { clientId: env('SNAPTRADE_CLIENT_ID'), consumerKey: env('SNAPTRADE_CONSUMER_KEY') };
      const commercial = !!(env('SNAPTRADE_USER_ID') && env('SNAPTRADE_USER_SECRET'));
      const sdk = new Snaptrade({ auth: commercial ? SnaptradeAuth.commercialApiKey(keys) : SnaptradeAuth.personalApiKey(keys) });
      const user = commercial ? { userId: env('SNAPTRADE_USER_ID'), userSecret: env('SNAPTRADE_USER_SECRET') } : {};
      return { sdk, user };
    },
    async connectUrl(returnTo, broker) {
      const { sdk, user } = await this.client();
      const body = { connectionType: 'read', darkMode: true, showCloseButton: true };
      if (returnTo) body.customRedirect = returnTo;
      if (broker) {
        const known = (await this.brokerages()).find((b) => b.slug === broker);
        if (!known) { const e = new Error('Unknown brokerage'); e.status = 400; throw e; }
        body.broker = known.slug;
      }
      const r = await sdk.authentication.loginSnapTradeUser({ ...user, ...body });
      const url = r.data?.redirectURI;
      if (!url) throw new Error('SnapTrade did not return a connection link.');
      return url;
    },
    brokerages() {
      return memo('st:brokerages', 24 * 3600e3, async () => {
        const { sdk } = await this.client();
        const list = (await sdk.referenceData.listAllBrokerages()).data || [];
        return list.filter((b) => b.enabled !== false && b.slug).map((b) => ({ slug: b.slug, name: b.display_name || b.name, realtime: !!b.is_real_time_connection, maintenance: !!b.maintenance_mode, degraded: !!b.is_degraded }))
          .sort((a, b) => a.name.localeCompare(b.name));
      });
    },
    accounts() {
      return memo('st:accounts', 3600e3, async () => { const { sdk, user } = await this.client(); return (await sdk.accountInformation.listUserAccounts({ ...user })).data || []; });
    },
    async refresh() { // asks every connected brokerage for fresh holdings (async; may cost extra on SnapTrade's daily plan)
      const { sdk, user } = await this.client();
      const auths = (await sdk.connections.listBrokerageAuthorizations({ ...user })).data || [];
      const out = [];
      for (const a of auths) {
        try { await sdk.connections.refreshBrokerageAuthorization({ authorizationId: a.id, ...user }); out.push({ broker: a.brokerage?.name || a.name, ok: true }); }
        catch (e) { out.push({ broker: a.brokerage?.name || a.name, ok: false, error: errMsg(e) }); }
      }
      return out;
    },
    async recentOrders() { // SnapTrade: "always realtime", last 24 h
      const { sdk, user } = await this.client();
      const accounts = await this.accounts();
      const out = [];
      await Promise.all(accounts.map(async (a) => {
        try {
          const r = (await sdk.accountInformation.getUserAccountRecentOrders({ accountId: a.id, onlyExecuted: false, ...user })).data || {};
          for (const o of r.orders || []) out.push(normalizeOrder('snaptrade', o, { accountId: a.id, broker: a.institution_name, account: a.name || a.institution_name }));
        } catch (e) { out.push({ error: errMsg(e), provider: 'snaptrade', broker: a.institution_name }); }
      }));
      return out;
    },
    async portfolio() {
      const { sdk, user } = await this.client();
      const accounts = (await sdk.accountInformation.listUserAccounts({ ...user })).data || [];
      const outAcc = [], outPos = [];
      await Promise.all(accounts.map(async (a) => {
        const acc = { provider: 'snaptrade', id: a.id, broker: a.institution_name || 'Broker', name: a.name || a.institution_name || 'Account', number: maskAcct(a.number), total: num(a.balance?.total?.amount), currency: a.balance?.total?.currency || 'USD', cash: null, synced: a.sync_status?.holdings?.last_successful_sync || null };
        try {
          const h = (await sdk.accountInformation.getUserHoldings({ accountId: a.id, ...user })).data || {};
          acc.cash = (h.balances || []).reduce((s, b) => s + (num(b.cash) || 0), 0);
          if (acc.total == null) acc.total = num(h.total_value?.value);
          for (const p of h.positions || []) {
            const us = p.symbol?.symbol || {};
            const type = String(us.type?.code || us.type?.description || '').toLowerCase();
            const isCrypto = type.includes('crypto');
            outPos.push(position({
              provider: 'snaptrade', accountId: a.id, broker: acc.broker, account: acc.name,
              symbol: us.symbol || us.raw_symbol, chartSymbol: toChartSymbol(us.symbol || us.raw_symbol, isCrypto),
              name: us.description || p.symbol?.description || '', assetClass: isCrypto ? 'crypto' : type === 'et' || type.includes('etf') ? 'etf' : 'stock',
              qty: num(p.units) ?? num(p.fractional_units) ?? 0,
              price: p.price, avgCost: p.average_purchase_price, pnl: p.open_pnl,
              currency: p.currency?.code || us.currency?.code || 'USD',
            }));
          }
        } catch (e) { acc.error = errMsg(e); }
        outAcc.push(acc);
      }));
      return { accounts: outAcc, positions: outPos };
    },
  },

  alpaca: {
    name: 'Alpaca',
    configured: () => !!(env('ALPACA_KEY_ID') && env('ALPACA_SECRET_KEY')),
    base: () => (env('ALPACA_PAPER').toLowerCase() === 'false' ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets'),
    async get(path) {
      const r = await fetch(this.base() + path, { headers: { 'APCA-API-KEY-ID': env('ALPACA_KEY_ID'), 'APCA-API-SECRET-KEY': env('ALPACA_SECRET_KEY'), Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
      if (!r.ok) throw new Error(`Alpaca HTTP ${r.status}${r.status === 401 || r.status === 403 ? ' — check ALPACA_KEY_ID / ALPACA_SECRET_KEY and ALPACA_PAPER' : ''}`);
      return r.json();
    },
    async recentOrders() {
      const paper = this.base().includes('paper');
      const rows = await this.get('/v2/orders?status=all&limit=50&direction=desc');
      return (rows || []).map((o) => normalizeOrder('alpaca', o, { broker: paper ? 'Alpaca (paper)' : 'Alpaca', account: paper ? 'Paper account' : 'Brokerage' }));
    },
    async portfolio() {
      const [a, pos] = await Promise.all([this.get('/v2/account'), this.get('/v2/positions')]);
      const paper = this.base().includes('paper');
      const acc = { provider: 'alpaca', id: a.id, broker: paper ? 'Alpaca (paper)' : 'Alpaca', name: paper ? 'Paper account' : 'Brokerage', number: maskAcct(a.account_number), total: num(a.equity) ?? num(a.portfolio_value), cash: num(a.cash), currency: a.currency || 'USD' };
      return {
        accounts: [acc],
        positions: (pos || []).map((p) => {
          const isCrypto = p.asset_class === 'crypto';
          const sign = p.side === 'short' ? -1 : 1;
          return position({ provider: 'alpaca', accountId: a.id, broker: acc.broker, account: acc.name, symbol: p.symbol, chartSymbol: toChartSymbol(p.symbol, isCrypto), name: '', assetClass: isCrypto ? 'crypto' : 'stock', qty: sign * Math.abs(num(p.qty) || 0), price: p.current_price, avgCost: p.avg_entry_price, value: p.market_value, pnl: p.unrealized_pl, currency: 'USD' });
        }),
      };
    },
  },

  coinbase: {
    name: 'Coinbase',
    configured: () => !!(env('COINBASE_API_KEY_NAME') && env('COINBASE_API_PRIVATE_KEY')),
    async get(path, query = '') {
      const jwt = coinbaseJwt({ keyName: env('COINBASE_API_KEY_NAME'), secret: env('COINBASE_API_PRIVATE_KEY'), uri: `GET api.coinbase.com${path}` });
      const r = await fetch(`https://api.coinbase.com${path}${query}`, { headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
      if (!r.ok) throw new Error(`Coinbase HTTP ${r.status}${r.status === 401 ? ' — check COINBASE_API_KEY_NAME / COINBASE_API_PRIVATE_KEY (needs "view" permission)' : ''}`);
      return r.json();
    },
    async portfolio() {
      const j = await this.get('/api/v3/brokerage/accounts', '?limit=250');
      const CASH = new Set(['USD', 'USDC', 'USDT', 'DAI', 'PYUSD']);
      let cash = 0; const positions = [];
      for (const a of j.accounts || []) {
        const qty = (num(a.available_balance?.value) || 0) + (num(a.hold?.value) || 0);
        if (!qty) continue;
        if (CASH.has(a.currency)) { cash += qty; continue; }
        positions.push(position({ provider: 'coinbase', accountId: 'coinbase', broker: 'Coinbase', account: 'Advanced Trade', symbol: a.currency, chartSymbol: `${a.currency}-USD`, name: a.name || a.currency, assetClass: 'crypto', qty, price: null, avgCost: null, currency: 'USD' }));
      }
      return { accounts: [{ provider: 'coinbase', id: 'coinbase', broker: 'Coinbase', name: 'Advanced Trade', number: '', total: null, cash, currency: 'USD' }], positions };
    },
    async recentOrders() {
      const j = await this.get('/api/v3/brokerage/orders/historical/batch', '?limit=50');
      return (j.orders || []).map((o) => normalizeOrder('coinbase', o, { broker: 'Coinbase', account: 'Advanced Trade' }));
    },
  },

  robinhood: {
    name: 'Robinhood Crypto',
    configured: () => !!(env('ROBINHOOD_API_KEY') && env('ROBINHOOD_PRIVATE_KEY')),
    key: null,
    async get(pathWithQuery) {
      this.key ||= ed25519FromBase64(env('ROBINHOOD_PRIVATE_KEY'));
      const headers = robinhoodHeaders({ apiKey: env('ROBINHOOD_API_KEY'), privateKey: this.key, method: 'GET', path: pathWithQuery });
      const r = await fetch(`https://trading.robinhood.com${pathWithQuery}`, { headers, signal: AbortSignal.timeout(12_000) });
      if (!r.ok) throw new Error(`Robinhood HTTP ${r.status}${r.status === 401 || r.status === 403 ? ' — check ROBINHOOD_API_KEY / ROBINHOOD_PRIVATE_KEY and the key\'s permissions' : ''}`);
      return r.json();
    },
    async portfolio() {
      const [acct, hold] = await Promise.all([this.get('/api/v1/crypto/trading/accounts/'), this.get('/api/v1/crypto/trading/holdings/')]);
      const a = acct?.results?.[0] || acct || {};
      return {
        accounts: [{ provider: 'robinhood', id: a.account_number || 'robinhood', broker: 'Robinhood', name: 'Crypto', number: maskAcct(a.account_number), total: null, cash: num(a.buying_power), currency: a.buying_power_currency || 'USD' }],
        positions: (hold.results || []).filter((h) => num(h.total_quantity) > 0).map((h) => position({ provider: 'robinhood', accountId: a.account_number || 'robinhood', broker: 'Robinhood', account: 'Crypto', symbol: h.asset_code, chartSymbol: `${h.asset_code}-USD`, name: h.asset_code, assetClass: 'crypto', qty: num(h.total_quantity), price: null, avgCost: null, currency: 'USD' })),
      };
    },
    async recentOrders() {
      const since = new Date(Date.now() - 24 * 3600e3).toISOString();
      const j = await this.get(`/api/v1/crypto/trading/orders/?updated_at_start=${encodeURIComponent(since)}`);
      return (j.results || []).map((o) => normalizeOrder('robinhood', o, { broker: 'Robinhood', account: 'Crypto' }));
    },
  },

  demo: {
    name: 'Sample portfolio',
    configured: () => env('BROKER_DEMO') === '1',
    async portfolio() { return demoPortfolio(); },
  },
};

export function demoPortfolio() {
  const rows = [
    ['AAPL', 'Apple', 'stock', 25, 172.4], ['NVDA', 'NVIDIA', 'stock', 40, 98.1], ['TSLA', 'Tesla', 'stock', 12, 245.0],
    ['SPY', 'S&P 500 ETF', 'etf', 15, 520.3], ['PLTR', 'Palantir', 'stock', 120, 24.8], ['BTC-USD', 'Bitcoin', 'crypto', 0.15, 58200], ['SOL-USD', 'Solana', 'crypto', 18, 142.5],
  ];
  return {
    demo: true,
    accounts: [{ provider: 'demo', id: 'demo-1', broker: 'Sample Broker', name: 'Individual', number: '••4821', total: null, cash: 3150, currency: 'USD' }],
    positions: rows.map(([s, n, ac, q, avg]) => ({ provider: 'demo', accountId: 'demo-1', broker: 'Sample Broker', account: 'Individual', symbol: s.replace('-USD', ''), chartSymbol: s, name: n, assetClass: ac, qty: q, avgCost: avg, price: null, value: null, cost: avg * q, pnl: null, pnlPct: null, currency: 'USD' })),
  };
}

function errMsg(e) {
  const d = e?.responseBody || e?.response?.data;
  const m = (d && (d.detail || d.message || (typeof d === 'string' ? d : ''))) || e?.message || String(e);
  return String(m).slice(0, 200);
}

export function status() {
  return Object.entries(providers).map(([id, p]) => ({ id, name: p.name, configured: p.configured(), canConnect: !!p.connectUrl, liveMode: { alpaca: 'stream', coinbase: 'stream', snaptrade: 'webhook+poll', robinhood: 'poll', demo: 'none' }[id] }));
}

export async function portfolio() {
  const active = Object.entries(providers).filter(([, p]) => p.configured());
  const res = { accounts: [], positions: [], errors: [], providers: status(), asOf: Date.now(), demo: false };
  await Promise.all(active.map(async ([id, p]) => {
    try {
      const r = await p.portfolio();
      res.accounts.push(...r.accounts); res.positions.push(...r.positions);
      if (r.demo) res.demo = true;
    } catch (e) { res.errors.push({ provider: id, error: errMsg(e) }); }
  }));
  return res;
}

export async function connectUrl(provider, broker) {
  const returnTo = /^https:\/\//.test(env('APP_URL')) ? env('APP_URL').replace(/\/$/, '') + '/#portfolio' : undefined;
  const p = providers[provider];
  if (!p?.connectUrl) { const e = new Error('This provider has no connect flow'); e.status = 400; throw e; }
  if (!p.configured()) { const e = new Error(`${p.name} is not configured on the server`); e.status = 400; throw e; }
  return p.connectUrl(returnTo, broker || undefined);
}

export async function recentOrders() {
  const active = Object.entries(providers).filter(([id, p]) => p.configured() && p.recentOrders);
  const res = { orders: [], errors: [], asOf: Date.now() };
  await Promise.all(active.map(async ([id, p]) => {
    try {
      for (const o of await p.recentOrders()) { if (o.error) res.errors.push({ provider: id, error: `${o.broker || ''}: ${o.error}` }); else res.orders.push(o); }
    } catch (e) { res.errors.push({ provider: id, error: errMsg(e) }); }
  }));
  res.orders.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return res;
}
export const provider = (id) => providers[id];
export async function brokerages() { const p = providers.snaptrade; if (!p.configured()) return []; return p.brokerages(); }
export async function refreshConnections() { const p = providers.snaptrade; if (!p.configured()) { const e = new Error('SnapTrade is not configured'); e.status = 400; throw e; } return p.refresh(); }
