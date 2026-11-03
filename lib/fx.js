// TradeGuide — FX rates to USD for portfolio totals, liquidity checks and "≈ $" displays. No keys.
// open.er-api.com (all currencies) → Frankfurter (ECB) → built-in approximate table (never fails).
import { http } from './sources.js';
import { currencyInfo } from '../public/js/markets.js';

// Approximate fallback (units per 1 USD) — only used if both live sources are unreachable
const FALLBACK = { USD: 1, EUR: 0.92, GBP: 0.78, CHF: 0.88, JPY: 150, CNY: 7.2, HKD: 7.8, KRW: 1380, TWD: 32, INR: 84, SGD: 1.34, AUD: 1.52, NZD: 1.66, CAD: 1.37, BRL: 5.5, MXN: 18.5, ZAR: 18, SAR: 3.75, SEK: 10.6, NOK: 10.8, DKK: 6.9, ILS: 3.7 };
let cache = { at: 0, rates: FALLBACK, source: 'built-in (approximate)' };
let pending = null;

export function loadRates() {
  if (Date.now() - cache.at < 12 * 3600e3) return Promise.resolve(cache);
  if (pending) return pending;
  pending = (async () => {
    try {
      const j = await http('fx', 'https://open.er-api.com/v6/latest/USD', { as: 'json', timeout: 8000 });
      if (j.result === 'success' && j.rates?.EUR) { cache = { at: Date.now(), rates: { ...FALLBACK, ...j.rates }, source: 'open.er-api.com', date: j.time_last_update_utc }; return cache; }
    } catch { /* next */ }
    try {
      const j = await http('fx2', 'https://api.frankfurter.app/latest?from=USD', { as: 'json', timeout: 8000 });
      if (j.rates?.EUR) { cache = { at: Date.now(), rates: { ...FALLBACK, ...j.rates, USD: 1 }, source: 'Frankfurter (ECB)', date: j.date }; return cache; }
    } catch { /* fallback */ }
    cache = { ...cache, at: Date.now() - 11 * 3600e3 }; // retry in ~1h
    return cache;
  })().finally(() => { pending = null; });
  return pending;
}

// USD value of 1 unit of `cur` as quoted (handles pence / cents quotes like GBp, ZAc)
export function toUSDFactor(cur, rates = cache.rates) {
  const ci = currencyInfo(cur);
  const perUSD = rates[ci.major];
  if (!perUSD) return null;
  return 1 / perUSD / ci.divisor;
}
export const fxStatus = () => ({ source: cache.source, date: cache.date || null, currencies: Object.keys(cache.rates).length });
