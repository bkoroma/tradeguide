// TradeGuide — technical indicator library (pure functions, no DOM).
// Every function returns an array aligned to the input (null where not enough data).

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  let seed = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (prev == null) {
      seed += v;
      if (i === period - 1) { prev = seed / period; out[i] = prev; }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// EMA over a series that starts with nulls (e.g., MACD line)
function emaSparse(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null, count = 0, seed = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (prev == null) {
      seed += v; count++;
      if (count === period) { prev = seed / period; out[i] = prev; }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= period) {
      gain += g; loss += l;
      if (i === period) {
        gain /= period; loss /= period;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const sig = emaSparse(line, signal);
  const hist = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null));
  return { line, signal: sig, hist };
}

export function stdev(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let m = 0;
    for (let j = i - period + 1; j <= i; j++) m += values[j];
    m /= period;
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (values[j] - m) ** 2;
    out[i] = Math.sqrt(s / period);
  }
  return out;
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period), sd = stdev(closes, period);
  const upper = mid.map((m, i) => (m == null ? null : m + mult * sd[i]));
  const lower = mid.map((m, i) => (m == null ? null : m - mult * sd[i]));
  const pctB = closes.map((c, i) => (upper[i] == null || upper[i] === lower[i] ? null : (c - lower[i]) / (upper[i] - lower[i])));
  return { mid, upper, lower, pctB };
}

export function trueRange(high, low, close) {
  return high.map((h, i) => (i === 0 ? h - low[i] : Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1]))));
}

// Wilder smoothing
function wilder(values, period, startIdx = 0) {
  const out = new Array(values.length).fill(null);
  let acc = 0;
  for (let i = startIdx; i < values.length; i++) {
    const n = i - startIdx + 1;
    if (n < period) { acc += values[i]; continue; }
    if (n === period) { acc += values[i]; acc /= period; out[i] = acc; continue; }
    acc = (acc * (period - 1) + values[i]) / period;
    out[i] = acc;
  }
  return out;
}

export function atr(high, low, close, period = 14) {
  return wilder(trueRange(high, low, close), period);
}

export function adx(high, low, close, period = 14) {
  const n = close.length;
  const plusDM = new Array(n).fill(0), minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = high[i] - high[i - 1], down = low[i - 1] - low[i];
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = trueRange(high, low, close);
  const trS = wilder(tr, period, 1), pS = wilder(plusDM, period, 1), mS = wilder(minusDM, period, 1);
  const plusDI = trS.map((t, i) => (t ? (100 * pS[i]) / t : null));
  const minusDI = trS.map((t, i) => (t ? (100 * mS[i]) / t : null));
  const dx = plusDI.map((p, i) => (p == null || minusDI[i] == null || p + minusDI[i] === 0 ? null : (100 * Math.abs(p - minusDI[i])) / (p + minusDI[i])));
  const first = dx.findIndex((v) => v != null);
  const adxArr = new Array(n).fill(null);
  if (first >= 0) {
    const sm = wilder(dx.map((v) => v ?? 0), period, first);
    for (let i = first; i < n; i++) adxArr[i] = sm[i];
  }
  return { adx: adxArr, plusDI, minusDI };
}

export function stochastic(high, low, close, kPeriod = 14, dPeriod = 3) {
  const k = new Array(close.length).fill(null);
  for (let i = kPeriod - 1; i < close.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) { hh = Math.max(hh, high[j]); ll = Math.min(ll, low[j]); }
    k[i] = hh === ll ? 50 : (100 * (close[i] - ll)) / (hh - ll);
  }
  const d = new Array(close.length).fill(null);
  for (let i = 0; i < k.length; i++) {
    if (i < kPeriod - 1 + dPeriod - 1) continue;
    let s = 0;
    for (let j = i - dPeriod + 1; j <= i; j++) s += k[j];
    d[i] = s / dPeriod;
  }
  return { k, d };
}

export function obv(close, volume) {
  const out = new Array(close.length).fill(0);
  for (let i = 1; i < close.length; i++) {
    const v = volume[i] || 0;
    out[i] = out[i - 1] + (close[i] > close[i - 1] ? v : close[i] < close[i - 1] ? -v : 0);
  }
  return out;
}

export function rollingMax(values, period) {
  return values.map((_, i) => (i < period - 1 ? null : Math.max(...values.slice(i - period + 1, i + 1))));
}
export function rollingMin(values, period) {
  return values.map((_, i) => (i < period - 1 ? null : Math.min(...values.slice(i - period + 1, i + 1))));
}

// slope of linear regression over last `period` points, normalised by mean (fraction per bar)
export function slopeAt(values, i, period) {
  if (i < period - 1) return null;
  const ys = values.slice(i - period + 1, i + 1);
  if (ys.some((v) => v == null)) return null;
  const n = ys.length, xm = (n - 1) / 2, ym = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  ys.forEach((y, x) => { num += (x - xm) * (y - ym); den += (x - xm) ** 2; });
  return ym === 0 ? 0 : num / den / Math.abs(ym);
}
