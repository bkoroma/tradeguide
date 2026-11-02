// TradeGuide — signal, risk, trade-plan and backtest engine (pure, runs in browser and Node).
import * as I from './indicators.js';
import { classify, classVolatility } from './assets.js';

export const ENGINE_VERSION = '1.0.0';

export function periodsPerYear(assetClass, interval) {
  const crypto = assetClass === 'crypto';
  if (interval === '1wk') return 52;
  if (interval === '1h') return crypto ? 24 * 365 : 252 * 7;
  return crypto ? 365 : 252;
}

const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
const last = (arr) => arr[arr.length - 1];

// ---------- 1. Indicator series ----------
export function computeSeries(candles) {
  const o = candles.map((c) => c.o), h = candles.map((c) => c.h), l = candles.map((c) => c.l);
  const c = candles.map((x) => x.c), v = candles.map((x) => x.v || 0);
  const m = I.macd(c);
  const bb = I.bollinger(c);
  const dmi = I.adx(h, l, c);
  const st = I.stochastic(h, l, c);
  const ob = I.obv(c, v);
  return {
    o, h, l, c, v,
    sma20: I.sma(c, 20), sma50: I.sma(c, 50), sma200: I.sma(c, 200),
    ema21: I.ema(c, 21),
    rsi: I.rsi(c, 14),
    macd: m.line, macdSignal: m.signal, macdHist: m.hist,
    bbUpper: bb.upper, bbLower: bb.lower, bbMid: bb.mid, pctB: bb.pctB,
    atr: I.atr(h, l, c, 14),
    adx: dmi.adx, plusDI: dmi.plusDI, minusDI: dmi.minusDI,
    stochK: st.k, stochD: st.d,
    obv: ob, obvSma: I.sma(ob, 20),
    volSma: I.sma(v, 20),
    hi20: I.rollingMax(h, 20), lo20: I.rollingMin(l, 20),
  };
}

// ---------- 2. Composite signal ----------
// Each factor returns a score in [-1, 1] plus a plain-English reason.
export function scoreAt(S, i) {
  const c = S.c[i];
  const f = [];
  const add = (key, label, weight, score, reason) => { if (score != null && !Number.isNaN(score)) f.push({ key, label, weight, score: clamp(score), reason }); };

  // Trend: price vs MAs + MA alignment + slope, scaled by ADX trend strength
  const s50 = S.sma50[i], s200 = S.sma200[i], s20 = S.sma20[i];
  if (s50 != null) {
    let t = 0, parts = [];
    t += c > s50 ? 0.35 : -0.35; parts.push(c > s50 ? 'price above 50-MA' : 'price below 50-MA');
    if (s200 != null) {
      t += c > s200 ? 0.3 : -0.3; parts.push(c > s200 ? 'above 200-MA (long-term uptrend)' : 'below 200-MA (long-term downtrend)');
      t += s50 > s200 ? 0.2 : -0.2; parts.push(s50 > s200 ? '50-MA over 200-MA' : '50-MA under 200-MA');
    }
    const sl = I.slopeAt(S.sma50, i, 10);
    if (sl != null) { t += clamp(sl * 400, -0.15, 0.15); parts.push(sl > 0 ? '50-MA rising' : '50-MA falling'); }
    const a = S.adx[i];
    const strength = a == null ? 1 : clamp(a / 25, 0.5, 1.25);
    add('trend', 'Trend', 25, t * strength, parts.join(', ') + (a != null ? ` · ADX ${a.toFixed(0)} (${a >= 25 ? 'strong' : a >= 18 ? 'moderate' : 'weak'} trend)` : ''));
  } else if (s20 != null) {
    add('trend', 'Trend', 15, c > s20 ? 0.4 : -0.4, c > s20 ? 'price above 20-MA (short history)' : 'price below 20-MA (short history)');
  }

  // MACD momentum
  const mh = S.macdHist[i], mhp = S.macdHist[i - 1];
  if (mh != null && mhp != null) {
    const atr = S.atr[i] || Math.abs(c) * 0.02;
    let s = clamp(mh / (atr * 0.5)) * 0.7 + (mh > mhp ? 0.3 : -0.3);
    let r = mh > 0 ? 'MACD above signal (bullish momentum)' : 'MACD below signal (bearish momentum)';
    if (mh > 0 && mhp <= 0) { s = 1; r = 'MACD bullish crossover just fired'; }
    if (mh < 0 && mhp >= 0) { s = -1; r = 'MACD bearish crossover just fired'; }
    else r += mh > mhp ? ', strengthening' : ', fading';
    add('macd', 'MACD momentum', 15, s, r);
  }

  // RSI regime
  const r = S.rsi[i];
  if (r != null) {
    let s, why;
    if (r >= 80) { s = -0.8; why = `RSI ${r.toFixed(0)} — extremely overbought, pullback risk high`; }
    else if (r >= 70) { s = -0.3; why = `RSI ${r.toFixed(0)} — overbought; strong but stretched`; }
    else if (r >= 55) { s = 0.6; why = `RSI ${r.toFixed(0)} — healthy bullish momentum`; }
    else if (r >= 45) { s = 0; why = `RSI ${r.toFixed(0)} — neutral`; }
    else if (r >= 30) { s = -0.5; why = `RSI ${r.toFixed(0)} — bearish momentum`; }
    else if (r >= 20) { s = 0.3; why = `RSI ${r.toFixed(0)} — oversold; bounce possible but trend is weak`; }
    else { s = 0.6; why = `RSI ${r.toFixed(0)} — extremely oversold; mean-reversion bounce likely`; }
    add('rsi', 'RSI (14)', 15, s, why);
  }

  // Breakout / breakdown vs prior 20-bar range
  const hi = S.hi20[i - 1], lo = S.lo20[i - 1];
  if (hi != null && lo != null && hi > lo) {
    const pos = (c - lo) / (hi - lo);
    let s = (pos - 0.5) * 1.2, why = `price at ${(pos * 100).toFixed(0)}% of its 20-bar range`;
    if (c > hi) { s = 1; why = 'broke out above 20-bar high'; }
    if (c < lo) { s = -1; why = 'broke down below 20-bar low'; }
    add('breakout', 'Breakout', 15, s, why);
  }

  // Bollinger stretch (mean-reversion)
  const pb = S.pctB[i];
  if (pb != null) {
    let s = 0, why = 'inside Bollinger Bands';
    if (pb > 1) { s = -0.6; why = 'closed above upper Bollinger Band — stretched'; }
    else if (pb < 0) { s = 0.6; why = 'closed below lower Bollinger Band — stretched to downside'; }
    else if (pb > 0.8) { s = -0.15; why = 'near upper band'; }
    else if (pb < 0.2) { s = 0.15; why = 'near lower band'; }
    add('bollinger', 'Bollinger %B', 10, s, why);
  }

  // Stochastic
  const k = S.stochK[i], d = S.stochD[i], kp = S.stochK[i - 1], dp = S.stochD[i - 1];
  if (k != null && d != null && kp != null && dp != null) {
    let s = (k - 50) / 100, why = `%K ${k.toFixed(0)}`;
    if (kp <= dp && k > d && k < 30) { s = 0.9; why = 'bullish %K/%D cross in oversold zone'; }
    else if (kp >= dp && k < d && k > 70) { s = -0.9; why = 'bearish %K/%D cross in overbought zone'; }
    else if (k > 80) { s = -0.2; why = `%K ${k.toFixed(0)} — overbought`; }
    else if (k < 20) { s = 0.2; why = `%K ${k.toFixed(0)} — oversold`; }
    add('stoch', 'Stochastic', 10, s, why);
  }

  // Volume / OBV confirmation
  const ob = S.obv[i], obs = S.obvSma[i], vol = S.v[i], vs = S.volSma[i];
  if (obs != null && vs) {
    const priceUp = c > S.c[i - 1];
    let s = ob > obs ? 0.5 : -0.5;
    let why = ob > obs ? 'OBV above its average (buyers in control)' : 'OBV below its average (sellers in control)';
    const rel = vol / vs;
    if (rel > 1.5) { s += priceUp ? 0.4 : -0.4; why += ` · volume ${rel.toFixed(1)}× average on ${priceUp ? 'up' : 'down'} bar`; }
    add('volume', 'Volume / OBV', 10, s, why);
  }

  const wsum = f.reduce((a, x) => a + x.weight, 0);
  const score = wsum ? (f.reduce((a, x) => a + x.weight * x.score, 0) / wsum) * 100 : 0;
  const sign = Math.sign(score);
  const agree = f.length ? f.filter((x) => Math.sign(x.score) === sign && Math.abs(x.score) > 0.1).reduce((a, x) => a + x.weight, 0) / wsum : 0;
  return { score, factors: f, agreement: agree };
}

export function labelFor(score) {
  if (score >= 50) return { label: 'Strong Buy', tone: 'sbuy', action: 'BUY' };
  if (score >= 20) return { label: 'Buy', tone: 'buy', action: 'BUY' };
  if (score > -20) return { label: 'Hold / Wait', tone: 'hold', action: 'WAIT' };
  if (score > -50) return { label: 'Sell', tone: 'sell', action: 'SELL' };
  return { label: 'Strong Sell', tone: 'ssell', action: 'SELL' };
}

// ---------- 3. Risk ----------
function returns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  return r;
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
function quantile(a, q) { const s = [...a].sort((x, y) => x - y); const p = (s.length - 1) * q; const lo = Math.floor(p); return s[lo] + (s[Math.ceil(p)] - s[lo]) * (p - lo); }

export function maxDrawdown(closes) {
  let peak = -Infinity, mdd = 0, peakIdx = 0, troughIdx = 0, curPeakIdx = 0;
  closes.forEach((c, i) => {
    if (c > peak) { peak = c; curPeakIdx = i; }
    const dd = (c - peak) / peak;
    if (dd < mdd) { mdd = dd; peakIdx = curPeakIdx; troughIdx = i; }
  });
  return { mdd, peakIdx, troughIdx };
}

export function beta(candles, bench) {
  if (!bench || bench.length < 30) return null;
  const bm = new Map();
  for (let i = 1; i < bench.length; i++) bm.set(dayKey(bench[i].t), Math.log(bench[i].c / bench[i - 1].c));
  const xs = [], ys = [];
  for (let i = 1; i < candles.length; i++) {
    const b = bm.get(dayKey(candles[i].t));
    if (b != null && candles[i - 1].c > 0) { xs.push(b); ys.push(Math.log(candles[i].c / candles[i - 1].c)); }
  }
  if (xs.length < 30) return null;
  const mx = mean(xs), my = mean(ys);
  let cov = 0, vx = 0;
  xs.forEach((x, i) => { cov += (x - mx) * (ys[i] - my); vx += (x - mx) ** 2; });
  const b = vx ? cov / vx : null;
  const corr = vx ? cov / Math.sqrt(vx * ys.reduce((a, y) => a + (y - my) ** 2, 0)) : null;
  return { beta: b, corr, n: xs.length };
}
const dayKey = (t) => new Date(t * 1000).toISOString().slice(0, 10);

export function riskReport(candles, S, meta, bench) {
  const ppy = periodsPerYear(meta.assetClass, meta.interval);
  const look = Math.min(candles.length, Math.round(ppy)); // ~1 year
  const closes = S.c.slice(-look);
  const r = returns(closes);
  const annVol = sd(r) * Math.sqrt(ppy);
  const annRet = mean(r) * ppy;
  const downside = r.filter((x) => x < 0);
  const sortino = downside.length ? annRet / (sd(downside) * Math.sqrt(ppy)) : null;
  const sharpe = annVol ? annRet / annVol : null;
  const var95 = r.length > 20 ? -quantile(r, 0.05) : null;
  const tail = r.filter((x) => x <= -var95);
  const cvar95 = tail.length ? -mean(tail) : null;
  const dd = maxDrawdown(closes);
  const i = S.c.length - 1;
  const price = S.c[i];
  const atrPct = S.atr[i] ? S.atr[i] / price : null;
  const vs = S.volSma[i];
  const dollarVol = vs ? vs * price : null;
  const hi52 = Math.max(...S.h.slice(-look)), lo52 = Math.min(...S.l.slice(-look));
  const fromHigh = (price - hi52) / hi52;
  const b = beta(candles, bench);
  const chg5 = S.c.length > 6 ? (price - S.c[i - 5]) / S.c[i - 5] : 0;

  // Risk score 1–10 (higher = riskier)
  let pts = 0;
  pts += clamp((annVol - 0.12) / (1.0 - 0.12), 0, 1) * 4.5;      // volatility: 12%→0, 100%→4.5
  pts += clamp(-dd.mdd / 0.7, 0, 1) * 2.5;                      // drawdown: 70%→2.5
  if (dollarVol != null && meta.interval !== '1wk') pts += dollarVol < 1e6 ? 1.5 : dollarVol < 1e7 ? 0.8 : dollarVol < 5e7 ? 0.3 : 0;
  if (meta.assetClass === 'crypto') pts += 0.8;
  if (price < 5 && meta.assetClass !== 'crypto') pts += 0.7;
  if (b && b.beta > 1.5) pts += 0.5;
  const score = Math.round(clamp(1 + pts, 1, 10) * 10) / 10;
  const level = score <= 3 ? 'Low' : score <= 5 ? 'Moderate' : score <= 7 ? 'High' : score <= 8.5 ? 'Very High' : 'Extreme';

  // Plain-English warnings
  const w = [];
  const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
  const typicalDay = annVol / Math.sqrt(ppy);
  if (annVol > 0.6) w.push({ sev: 'high', text: `Very volatile: annualised volatility is ${pct(annVol)}. A normal ${meta.interval === '1h' ? 'hour' : meta.interval === '1wk' ? 'week' : 'day'} moves about ±${pct(typicalDay, 1)}.` });
  else if (annVol > 0.35) w.push({ sev: 'med', text: `Above-average volatility (${pct(annVol)} annualised). Expect swings of about ±${pct(typicalDay, 1)} per bar.` });
  if (dd.mdd < -0.4) w.push({ sev: 'high', text: `Lost ${pct(-dd.mdd)} peak-to-trough within the last year. Positions here can lose a large share of value quickly.` });
  else if (dd.mdd < -0.2) w.push({ sev: 'med', text: `Fell ${pct(-dd.mdd)} from peak at some point in the last year.` });
  if (var95 != null) w.push({ sev: 'info', text: `On 1 bar in 20, expect a loss of at least ${pct(var95, 1)} (historical 95% VaR); the average of those bad bars is ${pct(cvar95 ?? var95, 1)}.` });
  if (dollarVol != null && dollarVol < 1e7 && meta.interval !== '1wk') w.push({ sev: 'high', text: `Thin liquidity: about $${fmtBig(dollarVol)} traded per bar. Wide spreads and slippage are likely; stops may fill far from your price.` });
  if (price < 5 && meta.assetClass !== 'crypto') w.push({ sev: 'high', text: 'Penny-stock territory (under $5): higher manipulation, dilution and delisting risk.' });
  if (S.sma200[i] != null && price < S.sma200[i]) w.push({ sev: 'med', text: 'Trading below its 200-period average — long-term trend is down. Buying here is counter-trend.' });
  if (S.rsi[i] != null && S.rsi[i] > 75) w.push({ sev: 'med', text: `Overbought (RSI ${S.rsi[i].toFixed(0)}). Chasing after a big run raises the odds of buying a short-term top.` });
  if (S.rsi[i] != null && S.rsi[i] < 25) w.push({ sev: 'med', text: `Oversold (RSI ${S.rsi[i].toFixed(0)}). Falling prices can keep falling — "catching a falling knife" risk.` });
  if (Math.abs(chg5) > 0.15) w.push({ sev: 'med', text: `Moved ${chg5 > 0 ? '+' : ''}${pct(chg5)} in the last 5 bars. Sharp moves often partly reverse.` });
  if (b && b.beta > 1.5) w.push({ sev: 'med', text: `High beta (${b.beta.toFixed(2)}) vs ${meta.assetClass === 'crypto' ? 'Bitcoin' : 'the S&P 500'}: amplifies market drops.` });
  // Class-specific warnings: what is different about THIS kind of asset
  const C = classify(meta.symbol, meta.assetClass, meta.name);
  const cv = classVolatility(C.cls, annVol);
  if (C.cls === 'crypto') {
    w.push({ sev: 'med', text: 'Crypto trades 24/7 with no circuit breakers — big moves happen nights and weekends. No SIPC/FDIC: exchange, custody and regulatory risk are yours.' });
    if (b && b.corr != null && meta.symbol !== 'BTC-USD') w.push({ sev: b.corr > 0.7 ? 'med' : 'info', text: b.corr > 0.7 ? `Moves closely with Bitcoin (correlation ${b.corr.toFixed(2)}). Check BTC's trend first — this coin rarely goes against it.` : `Only loosely tied to Bitcoin (correlation ${b.corr.toFixed(2)}) — coin-specific news drives it more.` });
    if (dollarVol != null && dollarVol < 5e7 && meta.interval === '1d') w.push({ sev: 'med', text: 'Smaller coin by trading volume: more prone to pumps, dumps and exchange-specific price gaps.' });
  } else {
    w.push({ sev: 'info', text: `${C.cls === 'etf' ? 'ETFs' : 'Stocks'} only trade Mon–Fri 9:30–16:00 ET (plus thin extended hours). Overnight and earnings gaps can jump straight past your stop.` });
    if (C.cryptoLinked) w.push({ sev: 'med', text: `Crypto-linked ${C.cls === 'etf' ? 'ETF' : 'stock'} (${C.linkedNote}): trades on the stock market but swings with Bitcoin — expect crypto-sized moves in a stock wrapper.` });
    if (C.leveraged) w.push({ sev: 'high', text: 'Leveraged or inverse fund: resets daily and decays in choppy markets. Built for short-term trades, not holding.' });
  }
  if (cv.level === 'Extreme') w.push({ sev: 'high', text: `Volatility is extreme even by ${C.cls === 'crypto' ? 'crypto' : C.cls === 'etf' ? 'ETF' : 'stock'} standards (${pct(annVol)} vs typical ${C.profile.typicalVol}).` });
  if (fromHigh < -0.5) w.push({ sev: 'med', text: `Down ${pct(-fromHigh)} from its 1-year high — check for a fundamental reason before buying the dip.` });

  return { score, level, annVol, annRet, sharpe, sortino, var95, cvar95, maxDrawdown: dd.mdd, atrPct, dollarVol, hi52, lo52, fromHigh, beta: b, warnings: w, lookbackBars: look, assetClass: C.cls, classVol: cv, cryptoLinked: C.cryptoLinked, leveraged: C.leveraged };
}

export function fmtBig(n) {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

// ---------- 4. Trade plan ----------
export function tradePlan(S, signal, risk, opts = {}) {
  const { account = 10000, riskPct = 1, maxPositionPct = 25 } = opts;
  const atrMult = opts.atrMult ?? (risk?.assetClass === 'crypto' ? 2.5 : 2); // crypto needs room for normal noise
  const i = S.c.length - 1, price = S.c[i], atr = S.atr[i] || price * 0.02;
  const swingLow = Math.min(...S.l.slice(-10)), swingHigh = Math.max(...S.h.slice(-10));
  const long = signal.action !== 'SELL';

  // Stop: wider of ATR stop and just beyond recent swing, capped at 4×ATR
  let stop = long ? Math.max(price - atrMult * atr, Math.min(swingLow - 0.25 * atr, price - atr)) : Math.min(price + atrMult * atr, Math.max(swingHigh + 0.25 * atr, price + atr));
  if (long) stop = Math.max(stop, price - 4 * atr); else stop = Math.min(stop, price + 4 * atr);
  const perUnitRisk = Math.abs(price - stop);
  const t1 = long ? price + 2 * perUnitRisk : price - 2 * perUnitRisk;
  const t2 = long ? price + 3 * perUnitRisk : price - 3 * perUnitRisk;
  const resistance = long ? Math.max(...S.h.slice(-Math.min(S.h.length, 60))) : Math.min(...S.l.slice(-Math.min(S.l.length, 60)));
  const riskDollars = account * (riskPct / 100);
  let units = perUnitRisk > 0 ? riskDollars / perUnitRisk : 0;
  const maxUnits = (account * (maxPositionPct / 100)) / price;
  const capped = units > maxUnits;
  units = Math.min(units, maxUnits);
  const blocked = long && resistance > price && resistance < t1;
  return {
    direction: long ? 'long' : 'short',
    entry: price, stop, t1, t2, resistance,
    stopPct: (stop - price) / price, t1Pct: (t1 - price) / price, t2Pct: (t2 - price) / price,
    rr1: 2, rr2: 3,
    units, positionValue: units * price, riskDollars: units * perUnitRisk, capped,
    resistanceWarning: blocked ? `Recent high at ${fmtPx(resistance)} sits before Target 1 — price may stall there.` : null,
    trailing: long ? price - 3 * atr : price + 3 * atr,
  };
}

// ---------- 5. Backtest the signal itself ----------
// Long-only: enter when score crosses ≥ +buyAt, exit when score ≤ sellAt or ATR stop is hit. Fees per side.
export function computeScores(S, from = 60) {
  const n = S.c.length, out = new Array(n).fill(null);
  for (let i = Math.min(from, n - 1); i < n; i++) out[i] = scoreAt(S, i).score;
  return out;
}

export function backtest(candles, S, opts = {}) {
  // opts.scores: precomputed score series (reuse across many runs); opts.start/end: evaluate a window only
  const { buyAt = 20, sellAt = -20, feePct = 0.1, atrMult = 2 } = opts;
  const n = Math.min(opts.end ?? candles.length, candles.length);
  const warmup = Math.max(opts.start ?? opts.warmup ?? 60, 1);
  const scores = opts.scores || computeScores(S, Math.min(60, warmup));
  let inPos = false, entry = 0, stop = 0, equity = 1, peak = 1, mdd = 0, barsIn = 0, entryIdx = 0;
  const trades = [], markers = [], curve = [];
  const fee = feePct / 100;
  for (let i = warmup; i < n; i++) {
    const c = S.c[i], s = scores[i], sp = scores[i - 1];
    if (inPos) {
      barsIn++;
      const hitStop = S.l[i] <= stop;
      if (hitStop || s <= sellAt) {
        const exit = hitStop ? Math.min(stop, S.o[i]) : c;
        const ret = (exit / entry) * (1 - fee) * (1 - fee) - 1;
        equity *= 1 + ret;
        trades.push({ entryT: candles[entryIdx].t, exitT: candles[i].t, entry, exit, ret, reason: hitStop ? 'stop' : 'signal', bars: i - entryIdx });
        markers.push({ time: candles[i].t, kind: 'sell', text: hitStop ? 'Stop' : 'Sell' });
        inPos = false;
      } else {
        stop = Math.max(stop, c - (atrMult + 1) * (S.atr[i] || 0)); // trail
      }
    } else if (s != null && sp != null && s >= buyAt && sp < buyAt) {
      inPos = true; entry = c; entryIdx = i; stop = c - atrMult * (S.atr[i] || c * 0.02);
      markers.push({ time: candles[i].t, kind: 'buy', text: 'Buy' });
    }
    const mtm = inPos ? equity * (c / entry) : equity;
    peak = Math.max(peak, mtm); mdd = Math.min(mdd, (mtm - peak) / peak);
    curve.push({ time: candles[i].t, value: mtm });
  }
  const open = inPos ? { entryT: candles[entryIdx].t, entry, unrealised: S.c[n - 1] / entry - 1 } : null;
  if (inPos) equity *= S.c[n - 1] / entry;
  const wins = trades.filter((t) => t.ret > 0);
  const losses = trades.filter((t) => t.ret <= 0);
  const grossW = wins.reduce((a, t) => a + t.ret, 0), grossL = -losses.reduce((a, t) => a + t.ret, 0);
  const bh = S.c[n - 1] / S.c[warmup] - 1;
  let bhPeak = -Infinity, bhMdd = 0;
  for (let i = warmup; i < n; i++) { bhPeak = Math.max(bhPeak, S.c[i]); bhMdd = Math.min(bhMdd, (S.c[i] - bhPeak) / bhPeak); }
  return {
    totalReturn: equity - 1, buyHold: bh, maxDrawdown: mdd, buyHoldMaxDrawdown: bhMdd,
    trades: trades.length, winRate: trades.length ? wins.length / trades.length : null,
    avgWin: wins.length ? grossW / wins.length : null, avgLoss: losses.length ? -grossL / losses.length : null,
    profitFactor: grossL ? grossW / grossL : wins.length ? Infinity : null,
    exposure: barsIn / Math.max(1, n - warmup), tradeList: trades, markers, curve, open, scores,
    from: candles[warmup]?.t, to: candles[n - 1]?.t,
  };
}

// ---------- 6. One-call analysis ----------
export function analyze(candles, meta, bench = null, planOpts = {}) {
  if (!candles || candles.length < 30) throw new Error('Not enough price history to analyse (need at least 30 bars).');
  const S = computeSeries(candles);
  const i = S.c.length - 1;
  const sig = scoreAt(S, i);
  const lab = labelFor(sig.score);
  const prev = scoreAt(S, i - 1);
  const risk = riskReport(candles, S, meta, bench);
  const signal = { ...sig, ...lab, prevScore: prev.score, changed: labelFor(prev.score).action !== lab.action, confidence: confidenceOf(sig, risk) };
  const plan = tradePlan(S, signal, risk, planOpts);
  const bt = backtest(candles, S);
  return { meta, S, signal, risk, plan, backtest: bt, summary: summarize(meta, signal, risk, plan, bt), times: candles.map((x) => x.t), price: S.c[i], change: (S.c[i] - S.c[i - 1]) / S.c[i - 1], asOf: candles[i].t };
}

function confidenceOf(sig, risk) {
  // agreement of indicators, penalised by very high risk and short history
  let c = sig.agreement * 100;
  if (risk.score > 8) c -= 15; else if (risk.score > 6.5) c -= 7;
  c = Math.max(5, Math.min(95, c));
  return { value: Math.round(c), label: c >= 70 ? 'High' : c >= 50 ? 'Medium' : 'Low' };
}

function summarize(meta, s, r, p, bt) {
  const name = meta.symbol;
  const parts = [];
  if (s.action === 'BUY') parts.push(`${name} shows a ${s.label.toLowerCase()} setup (score ${s.score.toFixed(0)}/100, ${s.confidence.label.toLowerCase()} confidence).`);
  else if (s.action === 'SELL') parts.push(`${name} is flashing a ${s.label.toLowerCase()} signal (score ${s.score.toFixed(0)}/100). If you hold it, consider protecting gains or exiting; new buyers should wait.`);
  else parts.push(`${name} has no clear edge right now (score ${s.score.toFixed(0)}/100). Waiting for a confirmed setup is usually the better trade.`);
  parts.push(`Risk is ${r.level.toLowerCase()} (${r.score}/10).`);
  if (s.action === 'BUY') parts.push(`A disciplined plan: stop near ${fmtPx(p.stop)} (${(p.stopPct * 100).toFixed(1)}%), first target ${fmtPx(p.t1)} (+${(p.t1Pct * 100).toFixed(1)}%).`);
  if (bt.trades >= 3) {
    const beat = bt.totalReturn > bt.buyHold;
    parts.push(`Historically on this chart the signal ${beat ? 'beat' : 'trailed'} buy-and-hold (${pctS(bt.totalReturn)} vs ${pctS(bt.buyHold)}) with a ${(bt.winRate * 100).toFixed(0)}% win rate over ${bt.trades} trades${beat ? '' : ' — treat it with extra caution here'}.`);
  } else parts.push('Too few historical signals on this chart to judge reliability.');
  return parts.join(' ');
}
export const pctS = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
export function fmtPx(x) {
  if (x == null || !isFinite(x)) return '—';
  const a = Math.abs(x);
  const d = a >= 1000 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : 8;
  return x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
