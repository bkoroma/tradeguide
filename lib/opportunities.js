// TradeGuide — opportunity board, refreshed on a schedule while the server is awake.
// Scans a broad liquid universe for setups that have just triggered ("buy now") and setups forming
// ("upcoming"), ranked by readiness × how well that pattern has worked on each asset before.
import { getChart } from './market.js';
import { computeSeries, scoreAt, labelFor, riskReport } from '../public/js/engine.js';
import { findSetups, rankOpportunities, SETUPS_VERSION } from '../public/js/setups.js';
import { UNIVERSE } from '../public/js/data.js';
import { WORLD } from '../public/js/markets.js';

const env = (k) => (process.env[k] || '').trim();
const REFRESH_MS = Math.max(5, +(env('OPP_REFRESH_MIN') || 15)) * 60_000;

// Broad, liquid default universe (~130). Override with OPP_SYMBOLS=AAPL,MSFT,…
const MORE_US = ['ABBV', 'ACN', 'AMAT', 'ANET', 'APP', 'AXP', 'BKNG', 'BLK', 'C', 'CAT', 'CMG', 'CRWD', 'CSCO', 'CVX', 'DE', 'DELL', 'DHR', 'GE', 'GS', 'HON', 'IBM', 'INTU', 'ISRG', 'KLAC', 'LMT', 'LOW', 'LRCX', 'MCD', 'MRK', 'MRVL', 'MS', 'MU', 'NEE', 'NOW', 'PANW', 'PFE', 'PM', 'PYPL', 'RTX', 'SBUX', 'SCHW', 'SNOW', 'SPGI', 'T', 'TMO', 'TXN', 'UNP', 'UPS', 'VZ', 'WFC'];
export function universe() {
  if (env('OPP_SYMBOLS')) return env('OPP_SYMBOLS').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const world = env('EODHD_API_KEY') || env('TWELVEDATA_API_KEY') ? WORLD.slice(0, 40).map((w) => w.symbol) : []; // international only when a global data key is set
  return [...new Set([...UNIVERSE.stocks.map((x) => x.symbol), ...MORE_US, ...UNIVERSE.etfs.map((x) => x.symbol), ...UNIVERSE.crypto.map((x) => x.symbol), ...world])];
}

let board = null, running = null, timer = null;

export async function scanOpportunities({ symbols = universe(), concurrency = 4 } = {}) {
  const t0 = Date.now(), rows = [], errors = [];
  const queue = [...symbols];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const sym = queue.shift();
      try {
        const d = await getChart(sym, '1d');
        if (d.stale) throw new Error('only stale data available');
        const meta = { ...d.meta, interval: '1d' };
        const S = computeSeries(d.candles);
        const i = S.c.length - 1;
        const sc = scoreAt(S, i), risk = riskReport(d.candles, S, meta, null);
        rows.push({ symbol: meta.symbol, name: meta.name, assetClass: meta.assetClass, currency: meta.currency || 'USD', price: S.c[i], change: (S.c[i] - S.c[i - 1]) / S.c[i - 1], score: sc.score, signal: labelFor(sc.score).label, risk: risk.score, setups: findSetups(S), asOfBar: d.candles[i].t, source: d.source });
      } catch (e) { errors.push({ symbol: sym, error: String(e.message).slice(0, 140) }); }
    }
  }));
  const ranked = rankOpportunities(rows);
  const strip = (s) => ({ symbol: s.symbol, name: s.name, assetClass: s.assetClass, currency: s.currency, price: s.price, risk: s.risk, type: s.type, label: s.label, icon: s.icon, what: s.what, status: s.status, trigger: s.trigger, stop: s.stop, target: s.target, distPct: s.distPct, riskPct: s.riskPct, readiness: Math.round(s.readiness), barsAgo: s.barsAgo ?? null, reasons: s.reasons, verdict: s.verdict, histText: s.histText, history: s.history, rank: s.rank });
  return {
    version: SETUPS_VERSION, at: Date.now(), ms: Date.now() - t0, scanned: rows.length, requested: symbols.length,
    buyNow: ranked.buyNow.slice(0, 40).map(strip), upcoming: ranked.upcoming.slice(0, 60).map(strip), filteredOut: ranked.filteredOut,
    errors: errors.slice(0, 30), errorCount: errors.length,
    breadth: { bullish: rows.filter((r) => r.score >= 20).length, bearish: rows.filter((r) => r.score <= -20).length, total: rows.length },
  };
}

export function getBoard({ maxAgeMs = REFRESH_MS } = {}) {
  if (board && Date.now() - board.at < maxAgeMs) return Promise.resolve(board);
  if (!running) running = scanOpportunities().then((b) => { if (b.scanned) board = b; return b; }).finally(() => { running = null; });
  return board ? Promise.resolve({ ...board, refreshing: true }) : running; // serve the last board while refreshing
}

export function startOpportunityScheduler(log = console.log) {
  if (timer) return;
  const tick = () => getBoard({ maxAgeMs: 0 }).then((b) => log(`[ideas] ${b.scanned}/${b.requested} scanned in ${b.ms}ms — ${b.buyNow.length} buy-now, ${b.upcoming.length} upcoming${b.errorCount ? `, ${b.errorCount} errors` : ''}`)).catch((e) => log(`[ideas] scan failed: ${e.message}`));
  setTimeout(tick, 30_000).unref();
  timer = setInterval(tick, REFRESH_MS); timer.unref();
}
