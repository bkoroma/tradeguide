import { exchangeOf, exchangeStatus } from './markets.js';
// TradeGuide — asset classes: traditional stocks vs ETFs vs crypto.
// One place that knows how each market works: hours, normal volatility, what moves it,
// how it is regulated, and how to size and stop a trade in it. Pure; used by app, engine and bot.

// Crypto-linked equities and ETFs: traded like stocks, but they move with crypto.
export const CRYPTO_LINKED = {
  COIN: 'crypto exchange', MSTR: 'holds large BTC treasury', MARA: 'bitcoin miner', RIOT: 'bitcoin miner', CLSK: 'bitcoin miner',
  HUT: 'bitcoin miner', CIFR: 'bitcoin miner', IREN: 'bitcoin miner', CORZ: 'bitcoin miner/hosting', BITF: 'bitcoin miner', GLXY: 'crypto financial services',
  HOOD: 'large crypto trading revenue', IBIT: 'spot bitcoin ETF', FBTC: 'spot bitcoin ETF', GBTC: 'spot bitcoin ETF', ARKB: 'spot bitcoin ETF', BITB: 'spot bitcoin ETF',
  BITO: 'bitcoin futures ETF', ETHA: 'spot ether ETF', ETHE: 'spot ether ETF', BITX: '2× bitcoin ETF', CONL: '2× COIN ETF',
};
const KNOWN_ETF = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'VOO', 'VTI', 'IVV', 'VEA', 'VWO', 'AGG', 'BND', 'TLT', 'GLD', 'SLV', 'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLI', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC', 'SMH', 'SOXX', 'ARKK', 'USO', 'UNG', 'SCHD', 'VUG', 'VTV', 'VIG', 'VYM', 'EFA', 'EEM', 'HYG', 'LQD', 'IEF', 'SHY', 'BND', 'IAU', 'GDX', 'KRE', 'XBI', 'JEPI', 'JEPQ', 'RSP', 'MDY', 'IJH', 'IJR', 'TQQQ', 'SQQQ', 'SPXL', 'SOXL', 'UVXY',
  'IBIT', 'FBTC', 'GBTC', 'ARKB', 'BITB', 'BITO', 'ETHA', 'ETHE', 'BITX', 'CONL']);
const LEVERAGED_RE = /\b(2x|3x|-2x|-3x|ultra|ultrapro|leveraged|daily (bull|bear)|inverse)\b/i;

export const PROFILES = {
  stock: {
    key: 'stock', label: 'Stock', short: 'STOCK', color: '#4ea8ff', what: 'A share of ownership in a company. Its long-run value is anchored to the company’s earnings and cash flow.',
    hours: 'Mon–Fri 9:30–16:00 ET · extended 4:00–9:30 & 16:00–20:00', trades247: false,
    volBands: [0.18, 0.35, 0.6], typicalVol: '15–45% a year', atrMult: 2, suggestRiskPct: 1, maxRisk: 7, benchmark: 'SPY', benchName: 'S&P 500',
    settlement: 'T+1 (next business day)', protection: 'SEC/FINRA regulated. SIPC covers up to $500k if your broker fails (not market losses).',
    drivers: ['Earnings and guidance', 'Interest rates and the economy', 'Sector and market direction (S&P 500)', 'News, analyst ratings, buybacks, dividends'],
    risks: ['Overnight and earnings gaps can jump past a stop', 'Single-company risk: one bad report can drop it 20%+', 'Pattern-day-trader rule: under $25k in a margin account, max 3 day-trades per 5 days'],
    tip: 'Check the earnings date before entering; fundamentals (P/E, revenue growth) matter alongside the chart.',
  },
  etf: {
    key: 'etf', label: 'ETF', short: 'ETF', color: '#c084fc', what: 'A fund that trades like a stock and holds a basket (an index, sector, bonds, commodities…). Diversified by design.',
    hours: 'Mon–Fri 9:30–16:00 ET · extended 4:00–9:30 & 16:00–20:00', trades247: false,
    volBands: [0.12, 0.25, 0.45], typicalVol: '10–25% a year (broad index)', atrMult: 2, suggestRiskPct: 1, maxRisk: 7, benchmark: 'SPY', benchName: 'S&P 500',
    settlement: 'T+1', protection: 'SEC regulated fund; holdings are segregated. SIPC at the broker.',
    drivers: ['The index or basket it tracks', 'Market direction and rates', 'Fund flows'],
    risks: ['Tracking error and expense ratio', 'Leveraged/inverse ETFs lose value over time in choppy markets (daily-reset decay)', 'Thin ETFs can have wide spreads'],
    tip: 'Know what it holds. Leveraged ETFs are short-term trading tools, not long-term holdings.',
  },
  crypto: {
    key: 'crypto', label: 'Crypto', short: 'CRYPTO', color: '#f7931a', what: 'A digital asset on a blockchain. No company, earnings or dividends behind it — price is set by supply, demand, adoption and liquidity.',
    hours: '24/7/365 — never closes', trades247: true,
    volBands: [0.4, 0.7, 1.1], typicalVol: '40–100%+ a year', atrMult: 2.5, suggestRiskPct: 0.5, maxRisk: 9, benchmark: 'BTC-USD', benchName: 'Bitcoin',
    settlement: 'Minutes on-chain; instant inside an exchange', protection: 'No SIPC or FDIC. Exchange failure, hacks and custody are your risk. Regulation varies by country.',
    drivers: ['Bitcoin’s direction (most coins follow BTC)', 'Global liquidity and risk appetite', 'Regulation and spot-ETF flows', 'Token unlocks, network upgrades, exchange listings'],
    risks: ['Moves of 10%+ in a day are routine; 50–80% drawdowns have happened repeatedly', 'Trades through nights and weekends — gaps happen while you sleep', 'Exchange/custody risk; smaller coins can be illiquid or manipulated'],
    tip: 'Size smaller than you would a stock (about half), use wider stops, and know whether Bitcoin is trending before trading altcoins.',
  },
};

export function classify(symbol = '', assetClass = '', name = '') {
  const s = String(symbol).toUpperCase();
  const base = assetClass === 'crypto' || /-(USD|USDT|USDC|EUR|GBP|BTC|ETH)$/.test(s) ? 'crypto' : assetClass === 'etf' || KNOWN_ETF.has(s) ? 'etf' : 'stock';
  const linkedTo = base !== 'crypto' ? CRYPTO_LINKED[s] || null : null;
  const leveraged = base !== 'crypto' && LEVERAGED_RE.test(name || '');
  return { cls: base, profile: PROFILES[base], cryptoLinked: !!linkedTo, linkedNote: linkedTo, leveraged };
}

// Volatility compared with what is normal for the class
export function classVolatility(cls, annVol) {
  const p = PROFILES[cls] || PROFILES.stock, [a, b, c] = p.volBands;
  const level = annVol < a ? 'Calm' : annVol < b ? 'Typical' : annVol < c ? 'Volatile' : 'Extreme';
  const pos = Math.max(0, Math.min(1, annVol / (c * 1.4))); // 0..1 for a gauge
  return { level, text: `${level} for ${cls === 'etf' ? 'an ETF' : cls === 'crypto' ? 'crypto' : 'a stock'}`, bands: p.volBands, pos, scaleMax: c * 1.4 };
}

// ---------- US equity market clock (NYSE holidays & early closes) ----------
const HOLIDAYS = new Set([
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
const EARLY_CLOSE = new Set(['2025-07-03', '2025-11-28', '2025-12-24', '2026-11-27', '2026-12-24', '2027-11-26']);

function etNow(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  return { wd: p.weekday, day: `${p.year}-${p.month}-${p.day}`, mins: (+p.hour % 24) * 60 + +p.minute };
}
const isTradingDay = (day, wd) => wd !== 'Sat' && wd !== 'Sun' && !HOLIDAYS.has(day);

export function marketStatus(cls, d = new Date(), symbol = '') {
  if (cls !== 'crypto' && symbol) { const ex = exchangeOf(symbol); if (ex && ex.code !== 'US') return exchangeStatus(ex.code, d); }
  if (cls === 'crypto') return { open: true, phase: 'open', label: 'Open 24/7', detail: 'Crypto markets never close — including nights, weekends and holidays.' };
  const { wd, day, mins } = etNow(d);
  const close = EARLY_CLOSE.has(day) ? 13 * 60 : 16 * 60;
  if (isTradingDay(day, wd)) {
    if (mins >= 570 && mins < close) return { open: true, phase: 'open', label: 'Market open', detail: `Regular session until ${close === 780 ? '1:00 PM (early close)' : '4:00 PM'} ET.` };
    if (mins >= 240 && mins < 570) return { open: false, phase: 'pre', label: 'Pre-market', detail: 'Extended hours: thinner volume, wider spreads. Opens 9:30 AM ET.' };
    if (mins >= close && mins < 1200) return { open: false, phase: 'post', label: 'After-hours', detail: 'Extended hours until 8:00 PM ET. Earnings often land now.' };
  }
  // find next session
  let t = new Date(d.getTime());
  for (let k = 0; k < 10; k++) {
    const e = etNow(t);
    if (isTradingDay(e.day, e.wd) && (k > 0 || e.mins < 570)) {
      const reason = HOLIDAYS.has(day) ? 'Holiday' : wd === 'Sat' || wd === 'Sun' ? 'Weekend' : 'Closed';
      return { open: false, phase: 'closed', label: reason === 'Closed' ? 'Closed' : `Closed · ${reason}`, detail: `Next open ${k === 0 ? 'today' : e.wd} 9:30 AM ET${k > 1 ? ` (${e.day})` : ''}. Prices can gap at the open.` };
    }
    t = new Date(t.getTime() + 86400e3);
  }
  return { open: false, phase: 'closed', label: 'Closed', detail: '' };
}
