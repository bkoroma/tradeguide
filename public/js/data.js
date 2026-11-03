import { WORLD, exchangeOf } from './markets.js';
// TradeGuide — client data layer: API calls, caching, and clearly-labelled demo data fallback.

const mem = new Map();

async function api(path, params) {
  const qs = new URLSearchParams(params).toString();
  const key = `${path}?${qs}`;
  const hit = mem.get(key);
  if (hit && hit.exp > Date.now()) return hit.data;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`/api/${path}?${qs}`, { signal: ctrl.signal });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) throw Object.assign(new Error('API not available on this host'), { noApi: true });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    mem.set(key, { exp: Date.now() + 60_000, data: j });
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out');
    if (e instanceof TypeError) e.noApi = true; // network failure / file://
    throw e;
  } finally { clearTimeout(t); }
}

let apiDown = false;
export const isDemo = () => apiDown;

export async function getChart(symbol, interval = '1d') {
  if (!apiDown) {
    try { return await api('chart', { symbol, interval }); }
    catch (e) { if (!e.noApi) throw e; apiDown = true; }
  }
  return demoChart(symbol, interval);
}

export async function searchSymbols(q) {
  if (!q.trim()) return [];
  if (!apiDown) {
    try { return await api('search', { q }); }
    catch (e) { if (!e.noApi) throw e; apiDown = true; }
  }
  const all = [...UNIVERSE.stocks, ...UNIVERSE.etfs, ...UNIVERSE.crypto, ...WORLD];
  const u = q.toUpperCase();
  return all.filter((x) => x.symbol.includes(u) || x.name.toUpperCase().includes(u)).slice(0, 8)
    .map((x) => { const etf = UNIVERSE.etfs.some((e) => e.symbol === x.symbol), c = x.symbol.endsWith('-USD'); return { ...x, type: c ? 'CRYPTOCURRENCY' : etf ? 'ETF' : 'EQUITY', exchange: 'DEMO', assetClass: c ? 'crypto' : etf ? 'etf' : 'stock' }; });
}

export const UNIVERSE = {
  stocks: [
    { symbol: 'AAPL', name: 'Apple' }, { symbol: 'MSFT', name: 'Microsoft' }, { symbol: 'NVDA', name: 'NVIDIA' },
    { symbol: 'AMZN', name: 'Amazon' }, { symbol: 'GOOGL', name: 'Alphabet' }, { symbol: 'META', name: 'Meta Platforms' },
    { symbol: 'TSLA', name: 'Tesla' }, { symbol: 'AVGO', name: 'Broadcom' }, { symbol: 'BRK-B', name: 'Berkshire Hathaway' },
    { symbol: 'JPM', name: 'JPMorgan Chase' }, { symbol: 'V', name: 'Visa' }, { symbol: 'MA', name: 'Mastercard' },
    { symbol: 'LLY', name: 'Eli Lilly' }, { symbol: 'UNH', name: 'UnitedHealth' }, { symbol: 'XOM', name: 'Exxon Mobil' },
    { symbol: 'WMT', name: 'Walmart' }, { symbol: 'COST', name: 'Costco' }, { symbol: 'HD', name: 'Home Depot' },
    { symbol: 'PG', name: 'Procter & Gamble' }, { symbol: 'JNJ', name: 'Johnson & Johnson' }, { symbol: 'NFLX', name: 'Netflix' },
    { symbol: 'AMD', name: 'AMD' }, { symbol: 'ORCL', name: 'Oracle' }, { symbol: 'CRM', name: 'Salesforce' },
    { symbol: 'ADBE', name: 'Adobe' }, { symbol: 'INTC', name: 'Intel' }, { symbol: 'QCOM', name: 'Qualcomm' },
    { symbol: 'BAC', name: 'Bank of America' }, { symbol: 'KO', name: 'Coca-Cola' }, { symbol: 'PEP', name: 'PepsiCo' },
    { symbol: 'DIS', name: 'Disney' }, { symbol: 'NKE', name: 'Nike' }, { symbol: 'BA', name: 'Boeing' },
    { symbol: 'UBER', name: 'Uber' }, { symbol: 'SHOP', name: 'Shopify' }, { symbol: 'PLTR', name: 'Palantir' },
    { symbol: 'COIN', name: 'Coinbase' }, { symbol: 'MSTR', name: 'Strategy (MicroStrategy)' }, { symbol: 'HOOD', name: 'Robinhood' },
    { symbol: 'SOFI', name: 'SoFi' }, { symbol: 'SMCI', name: 'Super Micro Computer' }, { symbol: 'ARM', name: 'Arm Holdings' },
  ],
  etfs: [
    { symbol: 'SPY', name: 'S&P 500 ETF' }, { symbol: 'QQQ', name: 'Nasdaq-100 ETF' }, { symbol: 'IWM', name: 'Russell 2000 ETF' },
    { symbol: 'DIA', name: 'Dow Jones ETF' }, { symbol: 'VOO', name: 'Vanguard S&P 500' }, { symbol: 'VTI', name: 'Vanguard Total Market' },
    { symbol: 'VEA', name: 'Developed Markets' }, { symbol: 'VWO', name: 'Emerging Markets' }, { symbol: 'TLT', name: '20+ Yr Treasury' },
    { symbol: 'AGG', name: 'US Aggregate Bond' }, { symbol: 'GLD', name: 'Gold' }, { symbol: 'SLV', name: 'Silver' },
    { symbol: 'USO', name: 'Oil' }, { symbol: 'XLK', name: 'Technology' }, { symbol: 'XLF', name: 'Financials' },
    { symbol: 'XLE', name: 'Energy' }, { symbol: 'XLV', name: 'Health Care' }, { symbol: 'XLY', name: 'Consumer Discretionary' },
    { symbol: 'XLI', name: 'Industrials' }, { symbol: 'SMH', name: 'Semiconductors' }, { symbol: 'ARKK', name: 'ARK Innovation' },
    { symbol: 'IBIT', name: 'iShares Bitcoin Trust' }, { symbol: 'ETHA', name: 'iShares Ethereum Trust' }, { symbol: 'TQQQ', name: 'UltraPro QQQ (3×)' },
    { symbol: 'SCHD', name: 'US Dividend Equity' },
  ],
  crypto: [
    { symbol: 'BTC-USD', name: 'Bitcoin' }, { symbol: 'ETH-USD', name: 'Ethereum' }, { symbol: 'SOL-USD', name: 'Solana' },
    { symbol: 'XRP-USD', name: 'XRP' }, { symbol: 'BNB-USD', name: 'BNB' }, { symbol: 'ADA-USD', name: 'Cardano' },
    { symbol: 'DOGE-USD', name: 'Dogecoin' }, { symbol: 'AVAX-USD', name: 'Avalanche' }, { symbol: 'LINK-USD', name: 'Chainlink' },
    { symbol: 'LTC-USD', name: 'Litecoin' }, { symbol: 'DOT-USD', name: 'Polkadot' }, { symbol: 'BCH-USD', name: 'Bitcoin Cash' },
    { symbol: 'XLM-USD', name: 'Stellar' }, { symbol: 'SHIB-USD', name: 'Shiba Inu' }, { symbol: 'UNI-USD', name: 'Uniswap' },
    { symbol: 'AAVE-USD', name: 'Aave' }, { symbol: 'ATOM-USD', name: 'Cosmos' }, { symbol: 'NEAR-USD', name: 'NEAR Protocol' },
    { symbol: 'APT-USD', name: 'Aptos' }, { symbol: 'ARB-USD', name: 'Arbitrum' }, { symbol: 'SUI-USD', name: 'Sui' },
    { symbol: 'HBAR-USD', name: 'Hedera' }, { symbol: 'FIL-USD', name: 'Filecoin' }, { symbol: 'ETC-USD', name: 'Ethereum Classic' },
    { symbol: 'PEPE-USD', name: 'Pepe' },
  ],
};

// ---------- Demo data (synthetic, deterministic per symbol). Never presented as real. ----------
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(rnd) { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

export function demoChart(symbol, interval = '1d') {
  const sym = symbol.toUpperCase();
  const crypto = /-USD$/.test(sym);
  let h = 2166136261; for (const ch of sym + interval) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const rnd = seeded(h);
  const n = interval === '1wk' ? 520 : interval === '1h' ? 900 : 750;
  const step = interval === '1wk' ? 604800 : interval === '1h' ? 3600 : 86400;
  const annVol = crypto ? 0.55 + rnd() * 0.5 : 0.18 + rnd() * 0.35;
  const ppy = interval === '1wk' ? 52 : interval === '1h' ? (crypto ? 8760 : 1764) : crypto ? 365 : 252;
  const sigma = annVol / Math.sqrt(ppy);
  let price = crypto ? (sym.startsWith('BTC') ? 60000 : 5 + rnd() * 300) : 20 + rnd() * 400;
  let drift = (rnd() - 0.4) * 0.6 / ppy;
  const now = Math.floor(Date.now() / 1000 / step) * step;
  const candles = [];
  for (let i = 0; i < n; i++) {
    if (rnd() < 0.01) drift = (rnd() - 0.45) * 0.9 / ppy; // regime change
    const r = drift + sigma * gauss(rnd);
    const o = price;
    const c = Math.max(0.0001, o * Math.exp(r));
    const hi = Math.max(o, c) * (1 + Math.abs(gauss(rnd)) * sigma * 0.5);
    const lo = Math.min(o, c) * (1 - Math.abs(gauss(rnd)) * sigma * 0.5);
    const v = Math.round((crypto ? 2e4 : 5e6) * (0.6 + rnd()) * (1 + Math.abs(r) / sigma * 0.4));
    candles.push({ t: now - (n - 1 - i) * step, o, h: hi, l: lo, c, v });
    price = c;
  }
  const known = [...UNIVERSE.stocks, ...UNIVERSE.etfs, ...UNIVERSE.crypto].find((x) => x.symbol === sym);
  return {
    source: 'DEMO (synthetic data)', demo: true,
    meta: { symbol: sym, name: ((known || WORLD.find((w) => w.symbol === sym))?.name || sym) + ' (demo)', currency: crypto ? 'USD' : exchangeOf(sym)?.currency || 'USD', exchange: 'DEMO', quoteType: crypto ? 'CRYPTOCURRENCY' : UNIVERSE.etfs.some((e) => e.symbol === sym) ? 'ETF' : 'EQUITY', assetClass: crypto ? 'crypto' : UNIVERSE.etfs.some((e) => e.symbol === sym) ? 'etf' : 'stock', interval },
    candles,
  };
}

// ---------- Brokerage (read-only) ----------
const TOKEN_KEY = 'tg:access';
export const access = {
  get() { try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } },
  set(t, remember) { try { this.clear(); (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, t); } catch { /* storage blocked */ } },
  clear() { try { sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY); } catch { /* */ } },
};

async function brokerApi(action, params = {}, base = 'broker') {
  const qs = new URLSearchParams(params).toString();
  let r;
  try {
    r = await fetch(`/api/${base}/${action}${qs ? '?' + qs : ''}`, { headers: { Authorization: `Bearer ${access.get()}` }, cache: 'no-store' });
  } catch { throw Object.assign(new Error('Server not reachable. Broker connections need the deployed server (not static files).'), { noApi: true }); }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) throw Object.assign(new Error('Broker API not available on this host. Deploy with the included server or Netlify/Vercel functions.'), { noApi: true });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
  return j;
}
export const botApi = {
  status: () => brokerApi('status', {}, 'bot'),
  run: () => brokerApi('run', { all: '1' }, 'bot'),
  test: () => brokerApi('test', {}, 'bot'),
};
export const broker = {
  status: () => brokerApi('status'),
  portfolio: () => brokerApi('portfolio'),
  connect: (provider) => brokerApi('connect', { provider }),
};

// Client-side sample portfolio (used for "Preview with sample portfolio"; clearly labelled)
export function samplePortfolio() {
  const rows = [
    ['AAPL', 'Apple', 'stock', 25, 172.4], ['NVDA', 'NVIDIA', 'stock', 40, 98.1], ['TSLA', 'Tesla', 'stock', 12, 245.0],
    ['SPY', 'S&P 500 ETF', 'etf', 15, 520.3], ['PLTR', 'Palantir', 'stock', 120, 24.8], ['BTC-USD', 'Bitcoin', 'crypto', 0.15, 58200], ['SOL-USD', 'Solana', 'crypto', 18, 142.5],
  ];
  return {
    demo: true, errors: [], asOf: Date.now(),
    providers: [{ id: 'demo', name: 'Sample portfolio', configured: true, canConnect: false }],
    accounts: [{ provider: 'demo', id: 'demo-1', broker: 'Sample Broker', name: 'Individual', number: '••4821', total: null, cash: 3150, currency: 'USD' }],
    positions: rows.map(([s, n, ac, q, avg]) => ({ provider: 'demo', accountId: 'demo-1', broker: 'Sample Broker', account: 'Individual', symbol: s.replace('-USD', ''), chartSymbol: s, name: n, assetClass: ac, qty: q, avgCost: avg, price: null, value: null, cost: avg * q, pnl: null, pnlPct: null, currency: 'USD' })),
  };
}

// ---------- Live trades ----------
export const liveApi = {
  ticket: () => brokerApi('ticket', {}, 'live'),
  status: () => brokerApi('status', {}, 'live'),
  orders: () => brokerApi('orders', {}, 'live'),
  brokerages: () => brokerApi('brokerages'),
  connect: (broker) => brokerApi('connect', broker ? { provider: 'snaptrade', broker } : { provider: 'snaptrade' }),
  refresh: () => brokerApi('refresh'),
};
