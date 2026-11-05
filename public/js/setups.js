// TradeGuide — setup scanner: finds trades BEFORE they trigger ("upcoming") and the moment they do ("buy now").
// Pure functions over the indicator series from engine.computeSeries(); shared by app, server and bot.
//
// Each setup gives an exact plan: buy-stop trigger, stop-loss, 2R target, readiness (0–100) and an expiry.
// Each setup is also replayed over this asset's own history: when the same pattern appeared before, how often
// did the trigger fill, and did price reach the target before the stop? Patterns that have lost money on an
// asset are marked and ranked down — the scanner only promotes what has actually worked there.
import * as I from './indicators.js';

export const SETUPS_VERSION = '1.0.0';
export const SETUP_INFO = {
  breakout: { label: 'Breakout watch', icon: '🚀', what: 'Price is coiling just under its recent high in an uptrend. Buy only if it breaks above the high.' },
  pullback: { label: 'Pullback in uptrend', icon: '↩️', what: 'A healthy dip to the rising average in an established uptrend. Buy when price turns back up through today’s high.' },
  macd_turn: { label: 'Momentum turning up', icon: '📈', what: 'MACD momentum has stopped falling and is about to cross up while the trend is intact.' },
  oversold_bounce: { label: 'Oversold bounce', icon: '🪃', what: 'Sharp sell-off inside a long-term uptrend; first sign of buyers returning. Short-term trade, tight stop.' },
};
const TRIGGER_WINDOW = 5;  // bars a setup stays valid waiting for its trigger
const HOLD_BARS = 20;      // bars to resolve a triggered trade in the historical replay
const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
const maxOf = (a, i, n) => { let m = -Infinity; for (let k = Math.max(0, i - n + 1); k <= i; k++) m = Math.max(m, a[k]); return m; };
const minOf = (a, i, n) => { let m = Infinity; for (let k = Math.max(0, i - n + 1); k <= i; k++) m = Math.min(m, a[k]); return m; };

// Bollinger bandwidth percentile over the last `look` bars (0 = tightest ever, 1 = widest)
function squeezePct(S, i, look = 120) {
  const bw = (k) => (S.bbMid[k] ? (S.bbUpper[k] - S.bbLower[k]) / S.bbMid[k] : null);
  const now = bw(i); if (now == null) return null;
  let below = 0, cnt = 0;
  for (let k = Math.max(20, i - look + 1); k <= i; k++) { const v = bw(k); if (v != null) { cnt++; if (v < now) below++; } }
  return cnt > 30 ? below / cnt : null;
}

// ---------- Detectors: each looks ONLY at bars <= i ----------
const detectors = {
  breakout(S, i) {
    const c = S.c[i], atr = S.atr[i], s50 = S.sma50[i];
    if (!atr || !s50 || S.sma50[i - 10] == null) return null;
    if (!(c > s50 && s50 >= S.sma50[i - 10])) return null;
    if (S.sma200[i] != null && c < S.sma200[i]) return null;
    const hi = maxOf(S.h, i, 20), dist = (hi - c) / atr;
    if (dist < 0 || dist > 1.5) return null;
    const sq = squeezePct(S, i), squeeze = sq != null && sq <= 0.3;
    const trigger = hi + 0.1 * atr;
    const stop = Math.min(trigger - 0.8 * atr, Math.max(minOf(S.l, i, 10) - 0.25 * atr, trigger - 2.5 * atr));
    const volUp = S.volSma[i] && S.v[i] > S.volSma[i];
    const reasons = [`${dist < 0.15 ? 'Pressing against' : `${dist.toFixed(1)}× ATR below`} its 20-day high (${hi.toFixed(2)})`, 'above a rising 50-day average'];
    if (squeeze) reasons.push(`volatility squeeze (bands tighter than ${Math.round((1 - sq) * 100)}% of the last 6 months)`);
    if (volUp) reasons.push('volume picking up');
    return { type: 'breakout', trigger, stop, readiness: clamp(100 - dist * 45 + (squeeze ? 15 : 0) + (volUp ? 5 : 0)), reasons };
  },
  pullback(S, i) {
    const c = S.c[i], atr = S.atr[i], s50 = S.sma50[i], s200 = S.sma200[i], e21 = S.ema21[i], r = S.rsi[i];
    if (!atr || !s50 || !s200 || !e21 || r == null || S.sma50[i - 10] == null) return null;
    if (!(s50 > s200 && c > s200 && s50 > S.sma50[i - 10])) return null;
    const touched = S.l[i] <= e21 * 1.01 || (c - s50) / atr < 1;
    if (!touched || c < s50 - 0.5 * atr || r < 38 || r > 55) return null;
    const trigger = S.h[i] + 0.05 * atr;
    const stop = Math.min(trigger - 0.8 * atr, minOf(S.l, i, 5) - 0.25 * atr);
    const turning = S.stochK[i] != null && S.stochK[i - 1] != null && S.stochK[i] > S.stochK[i - 1] && S.stochK[i - 1] < 35;
    const reasons = [`dipped to the rising ${S.l[i] <= e21 * 1.01 ? '21-day' : '50-day'} average in an uptrend`, `RSI cooled to ${r.toFixed(0)}`];
    if (turning) reasons.push('stochastic turning up from oversold');
    if (c > S.o[i]) reasons.push('closed green');
    return { type: 'pullback', trigger, stop, readiness: clamp(55 + (turning ? 20 : 0) + (c > S.o[i] ? 10 : 0) + (r < 45 ? 5 : 0)), reasons };
  },
  macd_turn(S, i) {
    const h0 = S.macdHist[i], h1 = S.macdHist[i - 1], h2 = S.macdHist[i - 2], atr = S.atr[i], c = S.c[i];
    if ([h0, h1, h2].some((x) => x == null) || !atr || !S.sma50[i]) return null;
    if (!(h0 < 0 && h0 > h1 && h1 > h2 && Math.abs(h0) < 0.25 * atr && c > S.sma50[i])) return null;
    const trigger = maxOf(S.h, i, 3) + 0.05 * atr;
    const stop = Math.min(trigger - 0.8 * atr, minOf(S.l, i, 10) - 0.25 * atr);
    return { type: 'macd_turn', trigger, stop, readiness: clamp(55 + (1 - Math.abs(h0) / (0.25 * atr)) * 35), reasons: ['MACD histogram rising 3 days in a row', 'about to cross above its signal line', 'price above the 50-day average'] };
  },
  oversold_bounce(S, i) {
    const c = S.c[i], atr = S.atr[i], r = S.rsi[i], rp = S.rsi[i - 1];
    if (!atr || r == null || rp == null || !S.sma200[i]) return null;
    if (!(c > S.sma200[i] && (r < 32 || (rp < 30 && r >= 30)) && c > S.o[i])) return null;
    const trigger = S.h[i] + 0.05 * atr;
    const stop = Math.min(trigger - 0.8 * atr, S.l[i] - 0.5 * atr);
    return { type: 'oversold_bounce', trigger, stop, readiness: clamp(50 + (rp < 30 && r >= 30 ? 20 : 0) + (S.bbLower[i] && S.l[i] <= S.bbLower[i] ? 10 : 0)), reasons: [`RSI ${r.toFixed(0)} — deeply oversold`, 'still above the 200-day average (long-term uptrend)', 'buyers stepped in today (green close)'] };
  },
};

function finish(s, S, i) {
  const risk = s.trigger - s.stop;
  return { ...s, ...SETUP_INFO[s.type], target: s.trigger + 2 * risk, rr: 2, riskPct: risk / s.trigger, distPct: (s.trigger - S.c[i]) / S.c[i], detectedAt: i, expiresAfterBars: TRIGGER_WINDOW };
}

// ---------- Historical replay: what happened every previous time this pattern appeared on this asset ----------
export function replay(S, type, from = 210) {
  const det = detectors[type], n = S.c.length;
  let count = 0, fills = 0, wins = 0, sumR = 0;
  for (let i = from; i < n - 2; i++) {
    const s = det(S, i); if (!s) continue;
    count++;
    const plan = finish(s, S, i);
    let fillAt = -1, entry = 0;
    for (let j = i + 1; j <= Math.min(n - 1, i + TRIGGER_WINDOW); j++) if (S.h[j] >= plan.trigger) { fillAt = j; entry = Math.max(S.o[j], plan.trigger); break; }
    if (fillAt < 0) { i += TRIGGER_WINDOW; continue; } // expired unfilled
    fills++;
    const R = entry - plan.stop;
    let res = null, end = fillAt;
    for (let j = fillAt; j <= Math.min(n - 1, fillAt + HOLD_BARS); j++) {
      end = j;
      if (S.l[j] <= plan.stop) { res = (Math.min(S.o[j], plan.stop) - entry) / R; break; } // gap through stop counted
      if (S.h[j] >= plan.target) { res = (plan.target - entry) / R; break; }
    }
    if (res == null) res = (S.c[end] - entry) / R;
    if (res > 0) wins++;
    sumR += res;
    i = end; // no overlapping trades
  }
  return { seen: count, trades: fills, fillRate: count ? fills / count : null, winRate: fills ? wins / fills : null, avgR: fills ? sumR / fills : null };
}

// ---------- Live: upcoming setups now, and ones that triggered in the last few bars ----------
export function findSetups(S, { history = true } = {}) {
  const n = S.c.length, i = n - 1, out = { upcoming: [], triggered: [] };
  if (n < 230) return out;
  const stats = {};
  const statFor = (t) => (stats[t] ||= history ? replay(S, t) : null);
  for (const type of Object.keys(detectors)) {
    // upcoming: detected on the latest bar, trigger not yet hit
    const s = detectors[type](S, i);
    if (s) out.upcoming.push(grade({ ...finish(s, S, i), status: 'upcoming' }, statFor(type)));
    // triggered: detected in the previous TRIGGER_WINDOW bars and filled since, still between stop and target
    for (let k = i - 1; k >= i - TRIGGER_WINDOW; k--) {
      const p = detectors[type](S, k); if (!p) continue;
      const plan = finish(p, S, k);
      let fillAt = -1; for (let j = k + 1; j <= i; j++) if (S.h[j] >= plan.trigger) { fillAt = j; break; }
      if (fillAt < 0) break;
      const alive = minOf(S.l, i, i - fillAt + 1) > plan.stop && maxOf(S.h, i, i - fillAt + 1) < plan.target;
      const notChased = S.c[i] <= plan.trigger + 0.5 * (plan.trigger - plan.stop); // still near the entry
      if (alive && notChased) out.triggered.push(grade({ ...plan, status: 'triggered', barsAgo: i - fillAt }, statFor(type)));
      break;
    }
  }
  const done = new Set(out.triggered.map((x) => x.type)); // already triggered → not also 'upcoming'
  out.upcoming = out.upcoming.filter((x) => !done.has(x.type));
  return out;
}

// quality from this asset's own history; ranking used by the scanner
function grade(s, st) {
  const enough = st && st.trades >= 5;
  const exp = enough ? st.avgR : null;
  const verdict = !enough ? 'unproven' : exp > 0.25 ? 'strong' : exp > 0 ? 'positive' : 'negative';
  const histText = !st ? '' : st.trades ? `Seen ${st.seen}× before on this asset; ${st.trades} triggered, ${Math.round(st.winRate * 100)}% winners, avg ${st.avgR >= 0 ? '+' : ''}${st.avgR.toFixed(2)}R` : `Seen ${st.seen}× before; never triggered`;
  const rank = (s.status === 'triggered' ? 100 : s.readiness) * (1 + Math.max(-0.8, Math.min(1, exp ?? 0)));
  return { ...s, history: st, verdict, histText, rank: verdict === 'negative' ? rank * 0.3 : rank };
}

export function rankOpportunities(rows) {
  const flat = rows.flatMap((r) => [...r.setups.triggered, ...r.setups.upcoming].map((s) => ({ ...s, symbol: r.symbol, name: r.name, assetClass: r.assetClass, price: r.price, risk: r.risk, currency: r.currency })));
  const keep = (s) => s.verdict !== 'negative' && s.risk <= 9;
  const byRank = (a, b) => b.rank - a.rank;
  return {
    buyNow: flat.filter((s) => s.status === 'triggered' && keep(s)).sort(byRank),
    upcoming: flat.filter((s) => s.status === 'upcoming' && keep(s)).sort(byRank),
    filteredOut: flat.filter((s) => !keep(s)).length,
  };
}
