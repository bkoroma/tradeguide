// TradeGuide — the full tradable universe, refreshed daily from official public lists. No keys.
//   Stocks + ETFs: Nasdaq Trader symbol directory — every security listed on Nasdaq, NYSE,
//                  NYSE American, NYSE Arca, Cboe BZX and IEX (~12k), with an ETF flag.
//   Crypto:        every coin trading against USD on Coinbase and Kraken.
// Falls back to the built-in list if a download fails.
import { http } from './sources.js';

const DAY = 24 * 3600e3;
const SYMBOL_RE = /^[A-Z0-9.\-]{1,15}$/;
const STABLE = new Set(['USDC', 'USDT', 'DAI', 'PYUSD', 'USDS', 'EURC', 'GUSD', 'TUSD', 'USDP', 'FDUSD', 'RLUSD', 'USD1']);
const KRAKEN_NAMES = { XBT: 'BTC', XDG: 'DOGE' };
const EXCHANGES = { Q: 'Nasdaq', A: 'NYSE American', N: 'NYSE', P: 'NYSE Arca', Z: 'Cboe BZX', V: 'IEX' };

let state = { stocks: [], crypto: [], bySymbol: new Map(), loadedAt: 0, errors: [] };
let loading = null;

// "Apple Inc. - Common Stock" → "Apple Inc."
const tidy = (n) => String(n || '').replace(/\s+-\s+(Common Stock|Ordinary Shares|American Depositary Shares).*$/i, '').replace(/\s+(Common Stock|Ordinary Shares)$/i, '').trim();
const isOther = (n) => /\b(warrants?|rights?|units?|notes? due|debentures?|preferred|depositary shares? representing)\b/i.test(n);

// Pipe-delimited Nasdaq Trader file → rows keyed by header name
export function parsePipeFile(text) {
  const lines = String(text).trim().split(/\r?\n/);
  const head = lines.shift().split('|').map((h) => h.trim());
  return lines.filter((l) => !l.startsWith('File Creation Time')).map((l) => Object.fromEntries(l.split('|').map((v, i) => [head[i], v.trim()])));
}

export function buildStocks(nasdaqTxt, otherTxt) {
  const out = [];
  for (const r of parsePipeFile(nasdaqTxt)) {
    if (r['Test Issue'] === 'Y' || !r.Symbol) continue;
    out.push({ symbol: r.Symbol, rawName: r['Security Name'], etf: r.ETF === 'Y', exchange: 'Nasdaq', status: r['Financial Status'] || 'N' });
  }
  for (const r of parsePipeFile(otherTxt)) {
    const sym = r['ACT Symbol'] || r['CQS Symbol'];
    if (r['Test Issue'] === 'Y' || !sym) continue;
    out.push({ symbol: sym, rawName: r['Security Name'], etf: r.ETF === 'Y', exchange: EXCHANGES[r.Exchange] || r.Exchange || 'US', status: 'N' });
  }
  return out
    .map((x) => ({ ...x, symbol: x.symbol.replace('.', '-') })) // Yahoo-style class shares: BRK.B → BRK-B
    .filter((x) => SYMBOL_RE.test(x.symbol))
    .map((x) => ({ symbol: x.symbol, name: tidy(x.rawName), type: x.etf ? 'ETF' : 'EQUITY', assetClass: x.etf ? 'etf' : 'stock', exchange: x.exchange, other: isOther(x.rawName), distressed: x.status !== 'N' }));
}

export function buildCrypto(cbProducts, cbCurrencies, krakenPairs) {
  const names = new Map((Array.isArray(cbCurrencies) ? cbCurrencies : []).map((c) => [c.id, c.name]));
  const map = new Map();
  for (const p of Array.isArray(cbProducts) ? cbProducts : []) {
    if (p.quote_currency !== 'USD' || p.status !== 'online' || p.trading_disabled || STABLE.has(p.base_currency)) continue;
    map.set(p.base_currency, { exchanges: ['Coinbase'] });
  }
  for (const v of Object.values(krakenPairs?.result || {})) {
    const [b, q] = String(v.wsname || '').split('/');
    if (q !== 'USD' || (v.status && v.status !== 'online')) continue;
    const base = KRAKEN_NAMES[b] || b;
    if (!base || STABLE.has(base)) continue;
    const e = map.get(base) || { exchanges: [] };
    if (!e.exchanges.includes('Kraken')) e.exchanges.push('Kraken');
    map.set(base, e);
  }
  return [...map].map(([base, e]) => ({ symbol: `${base}-USD`, name: names.get(base) || base, type: 'CRYPTOCURRENCY', assetClass: 'crypto', exchange: e.exchanges.join(' · ') }))
    .filter((x) => SYMBOL_RE.test(x.symbol));
}

async function fallback() {
  const { UNIVERSE } = await import('../public/js/data.js');
  return {
    stocks: [...UNIVERSE.stocks.map((x) => ({ ...x, type: 'EQUITY', assetClass: 'stock', exchange: 'US' })), ...(UNIVERSE.etfs || []).map((x) => ({ ...x, type: 'ETF', assetClass: 'etf', exchange: 'US' }))],
    crypto: UNIVERSE.crypto.map((x) => ({ ...x, type: 'CRYPTOCURRENCY', assetClass: 'crypto', exchange: '' })),
  };
}

export function loadUniverse(force = false) {
  if (!force && state.loadedAt && Date.now() - state.loadedAt < DAY) return Promise.resolve(state);
  if (loading) return loading;
  loading = (async () => {
    const errors = [];
    const fb = await fallback();
    let stocks = [], crypto = [];
    try {
      const [a, b] = await Promise.all([
        http('nasdaqtrader', 'https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt', { as: 'text', timeout: 20_000 }),
        http('nasdaqtrader', 'https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt', { as: 'text', timeout: 20_000 }),
      ]);
      stocks = buildStocks(a, b);
      if (stocks.length < 1000) throw new Error(`only ${stocks.length} symbols`);
    } catch (e) { errors.push(`stocks: ${e.message}`); stocks = state.stocks.length ? state.stocks : fb.stocks; }
    try {
      const [p, c, k] = await Promise.all([
        http('coinbase', 'https://api.exchange.coinbase.com/products', { as: 'json', timeout: 15_000 }).catch(() => []),
        http('coinbase', 'https://api.exchange.coinbase.com/currencies', { as: 'json', timeout: 15_000 }).catch(() => []),
        http('kraken', 'https://api.kraken.com/0/public/AssetPairs', { as: 'json', timeout: 15_000 }).catch(() => ({})),
      ]);
      crypto = buildCrypto(p, c, k);
      if (crypto.length < 20) throw new Error(`only ${crypto.length} coins`);
    } catch (e) { errors.push(`crypto: ${e.message}`); crypto = state.crypto.length ? state.crypto : fb.crypto; }
    const bySymbol = new Map([...stocks, ...crypto].map((x) => [x.symbol, x]));
    // keep well-known names from the built-in list (directory names can be long legal names)
    for (const x of [...fb.stocks, ...fb.crypto]) if (bySymbol.has(x.symbol)) bySymbol.get(x.symbol).popular = true;
    state = { stocks, crypto, bySymbol, loadedAt: errors.length === 2 ? 0 : Date.now(), errors };
    return state;
  })().finally(() => { loading = null; });
  return loading;
}

export const peek = (symbol) => state.bySymbol.get(String(symbol || '').toUpperCase()) || null;
export function universeStats() {
  return { stocks: state.stocks.filter((x) => x.assetClass === 'stock').length, etfs: state.stocks.filter((x) => x.assetClass === 'etf').length, crypto: state.crypto.length, loadedAt: state.loadedAt || null, errors: state.errors };
}

// Ranked search across everything
export async function searchUniverse(q, { cls = '', limit = 15 } = {}) {
  await loadUniverse();
  const Q = String(q || '').trim().toUpperCase();
  if (!Q) return [];
  const Qn = Q.replace(/\s+/g, ' ');
  const pool = [...state.stocks, ...state.crypto].filter((x) => !cls || x.assetClass === cls);
  const scored = [];
  for (const x of pool) {
    const sym = x.symbol, base = sym.replace(/-USD$/, ''), name = x.name.toUpperCase();
    let s = 0;
    if (sym === Q || base === Q) s = 1000;
    else if (sym.startsWith(Q) || base.startsWith(Q)) s = 600 - sym.length * 5;
    else if (name.startsWith(Qn)) s = 400;
    else if (name.includes(' ' + Qn)) s = 250;
    else if (Qn.length >= 3 && name.includes(Qn)) s = 120;
    if (!s) continue;
    if (x.popular) s += 150;
    if (x.other) s -= 300;
    if (x.distressed) s -= 50;
    if (x.assetClass === 'crypto' && x.exchange.includes('·')) s += 20;
    scored.push([s, x]);
  }
  return scored.sort((a, b) => b[0] - a[0] || a[1].symbol.length - b[1].symbol.length).slice(0, limit)
    .map(([, x]) => ({ symbol: x.symbol, name: x.name, type: x.type, exchange: x.exchange, assetClass: x.assetClass }));
}

// Paged browse (for "all ETFs", "all crypto"…)
export async function browse({ cls = 'etf', offset = 0, limit = 100 } = {}) {
  await loadUniverse();
  const pool = (cls === 'crypto' ? state.crypto : state.stocks.filter((x) => x.assetClass === cls && !x.other)).slice().sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { total: pool.length, offset, items: pool.slice(offset, offset + Math.min(limit, 500)).map(({ symbol, name, exchange, assetClass }) => ({ symbol, name, exchange, assetClass })) };
}

export const _test = { reset() { state = { stocks: [], crypto: [], bySymbol: new Map(), loadedAt: 0, errors: [] }; } };
