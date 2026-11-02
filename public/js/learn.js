// TradeGuide — per-symbol learning: "what has this setup actually done on THIS asset before?"
// Pure JS, runs in the browser and in the bot. Three independent pieces of evidence:
//   1. Model:    logistic regression on indicator features → P(price higher in H bars),
//                trained on older history, validated on the most recent (unseen) slice with a purge gap.
//   2. Analogs:  every past bar whose signal score sat in the same bucket as today — how often did it go up?
//   3. Rules:    walk-forward tuning of buy/sell thresholds + stop width on the training slice,
//                then judged ONLY on the unseen slice.
// The decision engine demands that at least N of the 3 agree before calling BUY.
import { computeSeries, computeScores, scoreAt, labelFor, riskReport, tradePlan, backtest } from './engine.js';

export const LEARN_VERSION = '1.0.0';
const FACTORS = ['trend', 'macd', 'rsi', 'breakout', 'bollinger', 'stoch', 'volume'];

export function horizonFor(interval) { return interval === '1wk' ? 4 : interval === '1h' ? 24 : 10; }

// ---------- Features ----------
function featuresAt(S, i) {
  const f = scoreAt(S, i).factors;
  const m = Object.fromEntries(f.map((x) => [x.key, x.score]));
  const c = S.c[i];
  const ret20 = i >= 20 ? Math.max(-1, Math.min(1, c / S.c[i - 20] - 1)) : 0;
  const atrPct = S.atr[i] ? Math.min(0.3, S.atr[i] / c) : 0.02;
  const hi = Math.max(...S.h.slice(Math.max(0, i - 251), i + 1));
  return [...FACTORS.map((k) => m[k] ?? 0), S.rsi[i] != null ? (S.rsi[i] - 50) / 50 : 0, atrPct * 10, ret20, c / hi - 1];
}

export function buildDataset(S, from, H, cost = 0.002) {
  const X = [], y = [], idx = [], fwd = [];
  for (let i = from; i < S.c.length; i++) {
    X.push(featuresAt(S, i)); idx.push(i);
    if (i + H < S.c.length) { const r = S.c[i + H] / S.c[i] - 1; fwd.push(r); y.push(r > cost ? 1 : 0); }
    else { fwd.push(null); y.push(null); }
  }
  return { X, y, idx, fwd };
}

// ---------- Logistic regression (L2, batch gradient descent) ----------
export function standardize(X) {
  const d = X[0].length, mu = new Array(d).fill(0), sd = new Array(d).fill(0);
  X.forEach((r) => r.forEach((v, j) => (mu[j] += v / X.length)));
  X.forEach((r) => r.forEach((v, j) => (sd[j] += (v - mu[j]) ** 2 / X.length)));
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  return { mu, sd, apply: (r) => r.map((v, j) => (v - mu[j]) / sd[j]) };
}
const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export function trainLogistic(X, y, { iters = 400, lr = 0.15, l2 = 0.02 } = {}) {
  const n = X.length, d = X[0].length;
  const w = new Array(d).fill(0); let b = Math.log((y.reduce((a, v) => a + v, 0) + 1) / (n - y.reduce((a, v) => a + v, 0) + 1));
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b; for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const e = sigmoid(z) - y[i];
      gb += e; for (let j = 0; j < d; j++) gw[j] += e * X[i][j];
    }
    b -= (lr * gb) / n;
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
  }
  return { w, b, predict: (x) => { let z = b; for (let j = 0; j < d; j++) z += w[j] * x[j]; return sigmoid(z); } };
}

export function auc(scores, labels) {
  const pairs = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0]);
  let pos = 0, neg = 0, rankSum = 0;
  for (let i = 0; i < pairs.length;) {
    let j = i; while (j < pairs.length && pairs[j][0] === pairs[i][0]) j++;
    const avgRank = (i + j + 1) / 2; // 1-based average rank for ties
    for (let k = i; k < j; k++) if (pairs[k][1] === 1) { rankSum += avgRank; pos++; } else neg++;
    i = j;
  }
  return pos && neg ? (rankSum - (pos * (pos + 1)) / 2) / (pos * neg) : 0.5;
}

// ---------- Main: learn a symbol ----------
export function learnSymbol(candles, meta, opts = {}) {
  const S = opts.S || computeSeries(candles);
  const n = S.c.length;
  const H = opts.horizon || horizonFor(meta.interval);
  const warm = 210 <= n * 0.4 ? 210 : 60;
  if (n < warm + 120) return { ok: false, reason: `Need more history (${n} bars)`, horizon: H };
  const scores = opts.scores || computeScores(S, 60);
  const ds = buildDataset(S, warm, H);
  const labelled = ds.y.map((v, k) => (v == null ? -1 : k)).filter((k) => k >= 0);
  const split = Math.floor(labelled.length * 0.7);
  const trainK = labelled.slice(0, split - H); // purge gap of H bars so overlapping labels don't leak
  const testK = labelled.slice(split);

  // 1) Model
  let model = { ok: false };
  if (trainK.length > 80 && testK.length > 30) {
    const st = standardize(trainK.map((k) => ds.X[k]));
    const lr = trainLogistic(trainK.map((k) => st.apply(ds.X[k])), trainK.map((k) => ds.y[k]));
    const pTest = testK.map((k) => lr.predict(st.apply(ds.X[k])));
    const yTest = testK.map((k) => ds.y[k]);
    const a = auc(pTest, yTest);
    const acc = pTest.filter((p, i) => (p >= 0.5 ? 1 : 0) === yTest[i]).length / pTest.length;
    const base = yTest.reduce((s, v) => s + v, 0) / yTest.length;
    // retrain on everything labelled for the live prediction (same hyper-params, validated above)
    const stAll = standardize(labelled.map((k) => ds.X[k]));
    const lrAll = trainLogistic(labelled.map((k) => stAll.apply(ds.X[k])), labelled.map((k) => ds.y[k]));
    const pNow = lrAll.predict(stAll.apply(ds.X[ds.X.length - 1]));
    // top-quintile hit rate on unseen data: when the model was most confident, how often was it right?
    const ranked = pTest.map((p, i) => [p, yTest[i]]).sort((x, z) => z[0] - x[0]).slice(0, Math.max(5, Math.floor(pTest.length / 5)));
    const topHit = ranked.reduce((s, r) => s + r[1], 0) / ranked.length;
    model = { ok: true, pUp: pNow, auc: a, accuracy: acc, baseRate: base, topHit, trainN: trainK.length, testN: testK.length };
  }

  // 2) Analogs: same score bucket, history only (labels fully known)
  const bucketOf = (s) => (s >= 50 ? 4 : s >= 20 ? 3 : s > -20 ? 2 : s > -50 ? 1 : 0);
  const now = scores[n - 1];
  const b = bucketOf(now);
  const rets = [];
  for (let i = warm; i < n - H; i++) if (scores[i] != null && bucketOf(scores[i]) === b) rets.push(S.c[i + H] / S.c[i] - 1);
  const analogs = rets.length
    ? { n: rets.length, pUp: rets.filter((r) => r > 0.002).length / rets.length, mean: rets.reduce((a, r) => a + r, 0) / rets.length, median: [...rets].sort((a, z) => a - z)[Math.floor(rets.length / 2)], worst: Math.min(...rets), bucket: labelFor(now).label }
    : { n: 0, bucket: labelFor(now).label };

  // 3) Rules: tune on train window, judge on unseen window
  const splitBar = ds.idx[labelled[split]] ?? Math.floor(n * 0.7);
  const grid = [];
  for (const buyAt of [10, 20, 30, 40]) for (const sellAt of [-10, -20, -30]) for (const atrMult of [1.5, 2, 3]) grid.push({ buyAt, sellAt, atrMult });
  let best = null;
  for (const g of grid) {
    const r = backtest(candles, S, { ...g, scores, start: warm, end: splitBar });
    if (r.trades < 3) continue;
    const fit = r.totalReturn - 0.5 * Math.abs(r.maxDrawdown); // reward return, punish drawdown
    if (!best || fit > best.fit) best = { ...g, fit, train: { ret: r.totalReturn, trades: r.trades, winRate: r.winRate, pf: r.profitFactor, bh: r.buyHold } };
  }
  let rules = { ok: false, buyAt: 20, sellAt: -20, atrMult: 2 };
  if (best) {
    const t = backtest(candles, S, { ...best, scores, start: splitBar, end: n });
    rules = { ok: true, buyAt: best.buyAt, sellAt: best.sellAt, atrMult: best.atrMult, train: best.train, test: { ret: t.totalReturn, bh: t.buyHold, trades: t.trades, winRate: t.winRate, pf: t.profitFactor, mdd: t.maxDrawdown, from: candles[splitBar]?.t } };
  }
  return { ok: true, horizon: H, score: now, prevScore: scores[n - 2], model, analogs, rules, scores, S, version: LEARN_VERSION };
}

// ---------- Decision ----------
export const DEFAULTS = { minEvidence: 2, maxRisk: 8, minAuc: 0.54, minProb: 0.55, minAnalogN: 15, minAnalogP: 0.55 };

export function decide(candles, meta, learned, risk, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const L = learned;
  if (!L.ok) return { action: 'NONE', reason: L.reason, evidence: [] };
  const S = L.S, i = S.c.length - 1, price = S.c[i];
  const ev = [];
  const m = L.model;
  ev.push({ key: 'model', label: 'Model', pass: !!(m.ok && m.auc >= c.minAuc && m.pUp >= c.minProb), bear: !!(m.ok && m.auc >= c.minAuc && m.pUp <= 1 - c.minProb),
    text: m.ok ? `P(up in ${L.horizon} bars) ${(m.pUp * 100).toFixed(0)}% · unseen-data AUC ${m.auc.toFixed(2)}${m.auc < c.minAuc ? ' (too weak to trust)' : ''}` : 'not enough history' });
  const a = L.analogs;
  ev.push({ key: 'analogs', label: 'History', pass: a.n >= c.minAnalogN && a.pUp >= c.minAnalogP && a.mean > 0, bear: a.n >= c.minAnalogN && a.pUp <= 1 - c.minAnalogP && a.mean < 0,
    text: a.n ? `${a.n} past "${a.bucket}" readings: up ${(a.pUp * 100).toFixed(0)}% of the time, avg ${(a.mean * 100).toFixed(1)}% over ${L.horizon} bars` : 'no comparable past readings' });
  const r = L.rules;
  ev.push({ key: 'rules', label: 'Back-test', pass: !!(r.ok && r.test.trades >= 2 && r.test.ret > 0 && (r.test.pf ?? 0) >= 1.2), bear: !!(r.ok && r.test.trades >= 2 && r.test.ret < 0),
    text: r.ok ? `tuned rules on unseen data: ${(r.test.ret * 100).toFixed(1)}% vs buy&hold ${(r.test.bh * 100).toFixed(1)}%, ${r.test.trades} trades` : 'too few historical trades to tune' });

  const pass = ev.filter((e) => e.pass).length, bear = ev.filter((e) => e.bear).length;
  const buyLine = r.ok ? r.buyAt : 20, sellLine = r.ok ? r.sellAt : -20;
  const plan = tradePlan(S, { action: 'BUY' }, risk, { atrMult: r.ok ? r.atrMult : 2 });
  const base = { score: L.score, buyLine, sellLine, evidence: ev, evidenceCount: pass, bearCount: bear, risk: risk.score, price, plan, confidence: Math.round((pass / 3) * 100) };

  if (L.score >= buyLine && pass >= c.minEvidence && risk.score <= c.maxRisk) {
    return { ...base, action: 'BUY', reason: `Signal ${L.score.toFixed(0)} ≥ learned buy line ${buyLine}, ${pass}/3 evidence checks agree, risk ${risk.score}/10.` };
  }
  if (L.score <= sellLine || (bear >= 2 && L.score < 0)) {
    return { ...base, action: 'SELL', reason: L.score <= sellLine ? `Signal ${L.score.toFixed(0)} ≤ learned sell line ${sellLine}.` : `${bear}/3 evidence checks are bearish.` };
  }
  if (L.score >= buyLine) {
    const why = risk.score > c.maxRisk ? `risk ${risk.score}/10 is above your limit ${c.maxRisk}` : `only ${pass}/3 evidence checks agree`;
    return { ...base, action: 'WATCH', reason: `Signal is bullish but ${why}.` };
  }
  return { ...base, action: 'HOLD', reason: 'No edge right now.' };
}

// Convenience for UI: full learn + decide from candles
export function learnAndDecide(candles, meta, bench, cfg) {
  const S = computeSeries(candles);
  const risk = riskReport(candles, S, meta, bench);
  const L = learnSymbol(candles, meta, { S });
  return { learned: L, decision: decide(candles, meta, L, risk, cfg), risk };
}
