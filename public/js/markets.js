// TradeGuide — world exchanges. Pure module shared by browser and server.
// Symbols use the global Yahoo-style suffix convention: VOD.L (London), 0700.HK (Hong Kong),
// 600519.SS (Shanghai), 300750.SZ (Shenzhen), 7203.T (Tokyo), SAP.DE (Xetra), RELIANCE.NS (India)…
// Sessions are local exchange time in minutes; lunch breaks are separate sessions.
// Holidays are tracked for the US only (see assets.js); other markets show weekday hours.

const S = (h, m = 0) => h * 60 + m;
export const EXCHANGES = {
  US: { name: 'US (NYSE/Nasdaq)', short: 'US', country: 'United States', flag: '🇺🇸', currency: 'USD', tz: 'America/New_York', sessions: [[S(9, 30), S(16)]], weekend: [0, 6], bench: 'SPY', mic: 'XNYS' },
  L: { name: 'London Stock Exchange', short: 'LSE', country: 'United Kingdom', flag: '🇬🇧', currency: 'GBp', tz: 'Europe/London', sessions: [[S(8), S(16, 30)]], weekend: [0, 6], bench: 'EWU', mic: 'XLON', eodhd: 'LSE', stooq: 'uk' },
  DE: { name: 'Xetra (Frankfurt)', short: 'XETRA', country: 'Germany', flag: '🇩🇪', currency: 'EUR', tz: 'Europe/Berlin', sessions: [[S(9), S(17, 30)]], weekend: [0, 6], bench: 'EWG', mic: 'XETR', eodhd: 'XETRA', stooq: 'de' },
  PA: { name: 'Euronext Paris', short: 'PAR', country: 'France', flag: '🇫🇷', currency: 'EUR', tz: 'Europe/Paris', sessions: [[S(9), S(17, 30)]], weekend: [0, 6], bench: 'EWQ', mic: 'XPAR', eodhd: 'PA' },
  AS: { name: 'Euronext Amsterdam', short: 'AMS', country: 'Netherlands', flag: '🇳🇱', currency: 'EUR', tz: 'Europe/Amsterdam', sessions: [[S(9), S(17, 30)]], weekend: [0, 6], bench: 'EWN', mic: 'XAMS', eodhd: 'AS' },
  BR: { name: 'Euronext Brussels', short: 'BRU', country: 'Belgium', flag: '🇧🇪', currency: 'EUR', tz: 'Europe/Brussels', sessions: [[S(9), S(17, 30)]], weekend: [0, 6], bench: 'EWK', mic: 'XBRU', eodhd: 'BR' },
  MI: { name: 'Borsa Italiana (Milan)', short: 'MIL', country: 'Italy', flag: '🇮🇹', currency: 'EUR', tz: 'Europe/Rome', sessions: [[S(9), S(17, 30)]], weekend: [0, 6], bench: 'EWI', mic: 'XMIL', eodhd: 'MI' },
  MC: { name: 'Bolsa de Madrid', short: 'BME', country: 'Spain', flag: '🇪🇸', currency: 'EUR', tz: 'Europe/Madrid', sessions: [[S(9), S(17, 30)]], weekend: [0, 6], bench: 'EWP', mic: 'XMAD', eodhd: 'MC' },
  SW: { name: 'SIX Swiss Exchange', short: 'SIX', country: 'Switzerland', flag: '🇨🇭', currency: 'CHF', tz: 'Europe/Zurich', sessions: [[S(9), S(17, 30)]], weekend: [0, 6], bench: 'EWL', mic: 'XSWX', eodhd: 'SW' },
  ST: { name: 'Nasdaq Stockholm', short: 'STO', country: 'Sweden', flag: '🇸🇪', currency: 'SEK', tz: 'Europe/Stockholm', sessions: [[S(9), S(17, 30)]], weekend: [0, 6], bench: 'EWD', mic: 'XSTO', eodhd: 'ST' },
  CO: { name: 'Nasdaq Copenhagen', short: 'CPH', country: 'Denmark', flag: '🇩🇰', currency: 'DKK', tz: 'Europe/Copenhagen', sessions: [[S(9), S(17)]], weekend: [0, 6], bench: 'EDEN', mic: 'XCSE', eodhd: 'CO' },
  OL: { name: 'Oslo Børs', short: 'OSL', country: 'Norway', flag: '🇳🇴', currency: 'NOK', tz: 'Europe/Oslo', sessions: [[S(9), S(16, 20)]], weekend: [0, 6], bench: 'NORW', mic: 'XOSL', eodhd: 'OL' },
  HE: { name: 'Nasdaq Helsinki', short: 'HEL', country: 'Finland', flag: '🇫🇮', currency: 'EUR', tz: 'Europe/Helsinki', sessions: [[S(10), S(18, 30)]], weekend: [0, 6], bench: 'EFNL', mic: 'XHEL', eodhd: 'HE' },
  HK: { name: 'Hong Kong Exchange', short: 'HKEX', country: 'Hong Kong', flag: '🇭🇰', currency: 'HKD', tz: 'Asia/Hong_Kong', sessions: [[S(9, 30), S(12)], [S(13), S(16)]], weekend: [0, 6], bench: 'EWH', mic: 'XHKG', eodhd: 'HK', stooq: 'hk' },
  SS: { name: 'Shanghai Stock Exchange', short: 'SSE', country: 'China', flag: '🇨🇳', currency: 'CNY', tz: 'Asia/Shanghai', sessions: [[S(9, 30), S(11, 30)], [S(13), S(15)]], weekend: [0, 6], bench: 'ASHR', mic: 'XSHG', eodhd: 'SHG' },
  SZ: { name: 'Shenzhen Stock Exchange', short: 'SZSE', country: 'China', flag: '🇨🇳', currency: 'CNY', tz: 'Asia/Shanghai', sessions: [[S(9, 30), S(11, 30)], [S(13), S(15)]], weekend: [0, 6], bench: 'ASHR', mic: 'XSHE', eodhd: 'SHE' },
  T: { name: 'Tokyo Stock Exchange', short: 'TSE', country: 'Japan', flag: '🇯🇵', currency: 'JPY', tz: 'Asia/Tokyo', sessions: [[S(9), S(11, 30)], [S(12, 30), S(15, 30)]], weekend: [0, 6], bench: 'EWJ', mic: 'XTKS', eodhd: 'TSE', stooq: 'jp' },
  KS: { name: 'Korea Exchange (KOSPI)', short: 'KRX', country: 'South Korea', flag: '🇰🇷', currency: 'KRW', tz: 'Asia/Seoul', sessions: [[S(9), S(15, 30)]], weekend: [0, 6], bench: 'EWY', mic: 'XKRX', eodhd: 'KO' },
  KQ: { name: 'KOSDAQ', short: 'KOSDAQ', country: 'South Korea', flag: '🇰🇷', currency: 'KRW', tz: 'Asia/Seoul', sessions: [[S(9), S(15, 30)]], weekend: [0, 6], bench: 'EWY', mic: 'XKOS', eodhd: 'KQ' },
  TW: { name: 'Taiwan Stock Exchange', short: 'TWSE', country: 'Taiwan', flag: '🇹🇼', currency: 'TWD', tz: 'Asia/Taipei', sessions: [[S(9), S(13, 30)]], weekend: [0, 6], bench: 'EWT', mic: 'XTAI', eodhd: 'TW' },
  NS: { name: 'National Stock Exchange of India', short: 'NSE', country: 'India', flag: '🇮🇳', currency: 'INR', tz: 'Asia/Kolkata', sessions: [[S(9, 15), S(15, 30)]], weekend: [0, 6], bench: 'INDA', mic: 'XNSE', eodhd: 'NSE' },
  BO: { name: 'BSE (Bombay)', short: 'BSE', country: 'India', flag: '🇮🇳', currency: 'INR', tz: 'Asia/Kolkata', sessions: [[S(9, 15), S(15, 30)]], weekend: [0, 6], bench: 'INDA', mic: 'XBOM', eodhd: 'BSE' },
  SI: { name: 'Singapore Exchange', short: 'SGX', country: 'Singapore', flag: '🇸🇬', currency: 'SGD', tz: 'Asia/Singapore', sessions: [[S(9), S(12)], [S(13), S(17)]], weekend: [0, 6], bench: 'EWS', mic: 'XSES' },
  AX: { name: 'Australian Securities Exchange', short: 'ASX', country: 'Australia', flag: '🇦🇺', currency: 'AUD', tz: 'Australia/Sydney', sessions: [[S(10), S(16)]], weekend: [0, 6], bench: 'EWA', mic: 'XASX', eodhd: 'AU' },
  NZ: { name: 'NZX', short: 'NZX', country: 'New Zealand', flag: '🇳🇿', currency: 'NZD', tz: 'Pacific/Auckland', sessions: [[S(10), S(16, 45)]], weekend: [0, 6], bench: 'ENZL', mic: 'XNZE' },
  TO: { name: 'Toronto Stock Exchange', short: 'TSX', country: 'Canada', flag: '🇨🇦', currency: 'CAD', tz: 'America/Toronto', sessions: [[S(9, 30), S(16)]], weekend: [0, 6], bench: 'EWC', mic: 'XTSE', eodhd: 'TO' },
  V: { name: 'TSX Venture', short: 'TSXV', country: 'Canada', flag: '🇨🇦', currency: 'CAD', tz: 'America/Toronto', sessions: [[S(9, 30), S(16)]], weekend: [0, 6], bench: 'EWC', mic: 'XTSX', eodhd: 'V' },
  SA: { name: 'B3 (São Paulo)', short: 'B3', country: 'Brazil', flag: '🇧🇷', currency: 'BRL', tz: 'America/Sao_Paulo', sessions: [[S(10), S(17)]], weekend: [0, 6], bench: 'EWZ', mic: 'BVMF', eodhd: 'SA' },
  MX: { name: 'Bolsa Mexicana', short: 'BMV', country: 'Mexico', flag: '🇲🇽', currency: 'MXN', tz: 'America/Mexico_City', sessions: [[S(8, 30), S(15)]], weekend: [0, 6], bench: 'EWW', mic: 'XMEX', eodhd: 'MX' },
  JO: { name: 'Johannesburg Stock Exchange', short: 'JSE', country: 'South Africa', flag: '🇿🇦', currency: 'ZAc', tz: 'Africa/Johannesburg', sessions: [[S(9), S(17)]], weekend: [0, 6], bench: 'EZA', mic: 'XJSE', eodhd: 'JSE' },
  SR: { name: 'Saudi Exchange (Tadawul)', short: 'TADAWUL', country: 'Saudi Arabia', flag: '🇸🇦', currency: 'SAR', tz: 'Asia/Riyadh', sessions: [[S(10), S(15)]], weekend: [5, 6], bench: 'KSA', mic: 'XSAU', eodhd: 'SR' },
};

// Market-specific rules worth knowing before you trade there
export const RULES = {
  SS: 'China A-shares: daily price limit ±10% (±20% on the STAR Market, 688xxx). T+1 — shares bought today can only be sold tomorrow. Foreign investors usually access them via Stock Connect.',
  SZ: 'China A-shares: daily price limit ±10% (±20% on ChiNext, 300xxx). T+1 — shares bought today can only be sold tomorrow. Foreign investors usually access them via Stock Connect.',
  HK: 'Hong Kong: no daily price limits, a lunch break 12:00–13:00, and board lots (minimum trade size) that differ per stock.',
  T: 'Japan: daily price limits by price band, and most stocks trade in 100-share units.',
  KS: 'Korea: daily price limit ±30%.', KQ: 'Korea: daily price limit ±30%.',
  TW: 'Taiwan: daily price limit ±10%.',
  NS: 'India: price bands / circuit breakers per stock; foreign retail access is restricted.', BO: 'India: price bands / circuit breakers per stock; foreign retail access is restricted.',
  L: 'London prices are usually quoted in pence (GBp): 250 = £2.50. UK purchases may carry 0.5% stamp duty.',
  JO: 'Johannesburg prices are usually quoted in cents (ZAc): 25,000 = R250.',
  SR: 'Saudi Exchange trades Sunday–Thursday.',
};

const SUFFIX_RE = /\.([A-Z]{1,3})$/;
export function exchangeOf(symbol = '') {
  const s = String(symbol).toUpperCase();
  if (/-(USD|USDT|USDC|EUR|GBP)$/.test(s)) return null; // crypto
  const m = SUFFIX_RE.exec(s);
  if (m && EXCHANGES[m[1]]) return { code: m[1], ...EXCHANGES[m[1]], base: s.slice(0, -m[0].length) };
  return { code: 'US', ...EXCHANGES.US, base: s };
}
export const isInternational = (symbol) => { const e = exchangeOf(symbol); return !!e && e.code !== 'US'; };

// Accept common formats: "LSE:VOD", "VOD LN", "700 HK", "HKEX:700", "SHA:600519" → Yahoo style
const PREFIX = { LSE: 'L', LON: 'L', XETRA: 'DE', ETR: 'DE', FRA: 'DE', EPA: 'PA', PAR: 'PA', AMS: 'AS', BIT: 'MI', BME: 'MC', SWX: 'SW', SIX: 'SW', HKEX: 'HK', HKG: 'HK', HK: 'HK', SHA: 'SS', SSE: 'SS', SHE: 'SZ', SZSE: 'SZ', TYO: 'T', TSE: 'T', KRX: 'KS', TPE: 'TW', NSE: 'NS', BOM: 'BO', BSE: 'BO', SGX: 'SI', ASX: 'AX', TSX: 'TO', TSXV: 'V', B3: 'SA', BMV: 'MX', JSE: 'JO', TADAWUL: 'SR' };
const BBG = { LN: 'L', GR: 'DE', GY: 'DE', FP: 'PA', NA: 'AS', IM: 'MI', SM: 'MC', SW: 'SW', SE: 'SW', HK: 'HK', CH: 'SS', JP: 'T', JT: 'T', KS: 'KS', TT: 'TW', IN: 'NS', IS: 'NS', SP: 'SI', AU: 'AX', CN: 'TO', CT: 'TO', BZ: 'SA', MM: 'MX', SJ: 'JO', AB: 'SR' };
export function normalizeSymbol(input) {
  let s = String(input || '').trim().toUpperCase().replace(/\s+/g, ' ');
  let m = /^([A-Z]{2,7}):([A-Z0-9.\-]+)$/.exec(s);
  if (m && PREFIX[m[1]]) s = `${m[2]}.${PREFIX[m[1]]}`;
  m = /^([A-Z0-9.\-]+) ([A-Z]{2})$/.exec(s);
  if (m && BBG[m[2]]) s = `${m[1]}.${BBG[m[2]]}`;
  m = /^(\d{1,4})\.HK$/.exec(s); // Hong Kong codes are 4 digits
  if (m) s = `${m[1].padStart(4, '0')}.HK`;
  return s;
}

// ---------- Clock ----------
function partsIn(tz, d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { wd, mins: (+p.hour % 24) * 60 + +p.minute, y: +p.year, mo: +p.month, d: +p.day };
}
// offset of tz from UTC (minutes) at instant d
function tzOffset(tz, d) { const p = partsIn(tz, d); return Math.round((Date.UTC(p.y, p.mo - 1, p.d, Math.floor(p.mins / 60), p.mins % 60) - Math.floor(d.getTime() / 60000) * 60000) / 60000); }
// Date for a given local wall time (y, mo, d, minutes) in tz
function zoned(tz, y, mo, d, mins) { const guess = new Date(Date.UTC(y, mo - 1, d, Math.floor(mins / 60), mins % 60)); return new Date(guess.getTime() - tzOffset(tz, guess) * 60000); }
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function hoursText(code) {
  const x = EXCHANGES[code]; if (!x) return '';
  const days = x.weekend.includes(5) ? 'Sun–Thu' : 'Mon–Fri';
  return `${days} ${x.sessions.map(([a, b]) => `${hhmm(a)}–${hhmm(b)}`).join(' & ')} local`;
}
// session times converted to the viewer's own timezone (for "your time")
export function hoursInViewerTz(code, viewerTz, d = new Date()) {
  const x = EXCHANGES[code]; if (!x) return '';
  const p = partsIn(x.tz, d);
  const fmt = new Intl.DateTimeFormat(undefined, { timeZone: viewerTz, hour: 'numeric', minute: '2-digit' });
  return x.sessions.map(([a, b]) => `${fmt.format(zoned(x.tz, p.y, p.mo, p.d, a))}–${fmt.format(zoned(x.tz, p.y, p.mo, p.d, b))}`).join(' & ');
}

export function exchangeStatus(code, d = new Date()) {
  const x = EXCHANGES[code];
  if (!x) return { open: false, phase: 'closed', label: 'Unknown market', detail: '' };
  const p = partsIn(x.tz, d);
  const trading = !x.weekend.includes(p.wd);
  if (trading) {
    for (const [a, b] of x.sessions) if (p.mins >= a && p.mins < b) return { open: true, phase: 'open', label: 'Market open', detail: `${x.short} open until ${hhmm(b)} local time.`, closesInMin: b - p.mins };
    const first = x.sessions[0][0], last = x.sessions[x.sessions.length - 1][1];
    if (p.mins >= first && p.mins < last) { const next = x.sessions.find(([a]) => a > p.mins); return { open: false, phase: 'lunch', label: 'Lunch break', detail: `${x.short} reopens at ${hhmm(next[0])} local time.` }; }
    if (p.mins < first) return { open: false, phase: 'pre', label: 'Pre-open', detail: `${x.short} opens at ${hhmm(first)} local time (${x.tz.split('/').pop().replace('_', ' ')}).` };
  }
  // next trading day
  for (let k = 1; k <= 7; k++) {
    const nd = new Date(d.getTime() + k * 86400e3), np = partsIn(x.tz, nd);
    if (!x.weekend.includes(np.wd)) {
      const when = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(zoned(x.tz, np.y, np.mo, np.d, x.sessions[0][0]));
      return { open: false, phase: 'closed', label: trading ? 'Closed' : 'Closed · Weekend', detail: `${x.short} next opens ${when} your time.` };
    }
  }
  return { open: false, phase: 'closed', label: 'Closed', detail: '' };
}

// ---------- Currency ----------
const MINOR = { GBp: ['GBP', 100, 'p'], GBX: ['GBP', 100, 'p'], ZAc: ['ZAR', 100, 'c'], ILA: ['ILS', 100, 'ag'] };
export function currencyInfo(cur) { const m = MINOR[cur]; return m ? { major: m[0], divisor: m[1], minorSuffix: m[2] } : { major: (cur || 'USD').toUpperCase(), divisor: 1, minorSuffix: '' }; }
export function formatMoney(value, cur = 'USD', locale) {
  if (value == null || !Number.isFinite(value)) return '—';
  const ci = currencyInfo(cur);
  const a = Math.abs(value);
  const digits = a >= 1000 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : 8;
  if (ci.divisor !== 1) return `${value.toLocaleString(locale, { minimumFractionDigits: a >= 100 ? 0 : 2, maximumFractionDigits: a >= 100 ? 1 : 2 })}${ci.minorSuffix}`;
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency: ci.major, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value); }
  catch { return `${value.toLocaleString(locale, { maximumFractionDigits: digits })} ${ci.major}`; }
}

// ---------- Most-traded companies worldwide (always searchable, even with no data keys) ----------
// [symbol, name, US-listed ADR/alternative if one exists on NYSE/Nasdaq]
export const WORLD = [
  // United Kingdom
  ['SHEL.L', 'Shell', 'SHEL'], ['AZN.L', 'AstraZeneca', 'AZN'], ['HSBA.L', 'HSBC Holdings', 'HSBC'], ['ULVR.L', 'Unilever', 'UL'], ['BP.L', 'BP', 'BP'],
  ['GSK.L', 'GSK', 'GSK'], ['RIO.L', 'Rio Tinto', 'RIO'], ['BATS.L', 'British American Tobacco', 'BTI'], ['DGE.L', 'Diageo', 'DEO'], ['LSEG.L', 'London Stock Exchange Group'],
  ['REL.L', 'RELX', 'RELX'], ['BARC.L', 'Barclays', 'BCS'], ['LLOY.L', 'Lloyds Banking Group', 'LYG'], ['VOD.L', 'Vodafone', 'VOD'], ['RR.L', 'Rolls-Royce'],
  ['NG.L', 'National Grid', 'NGG'], ['TSCO.L', 'Tesco'], ['GLEN.L', 'Glencore'], ['BA.L', 'BAE Systems'], ['NWG.L', 'NatWest', 'NWG'], ['PRU.L', 'Prudential', 'PUK'],
  // Germany / Europe
  ['SAP.DE', 'SAP', 'SAP'], ['SIE.DE', 'Siemens'], ['ALV.DE', 'Allianz'], ['DTE.DE', 'Deutsche Telekom'], ['MBG.DE', 'Mercedes-Benz Group'], ['BMW.DE', 'BMW'],
  ['VOW3.DE', 'Volkswagen'], ['BAS.DE', 'BASF'], ['BAYN.DE', 'Bayer'], ['ADS.DE', 'Adidas'], ['DBK.DE', 'Deutsche Bank'], ['IFX.DE', 'Infineon'], ['RHM.DE', 'Rheinmetall'], ['MUV2.DE', 'Munich Re'],
  ['MC.PA', 'LVMH'], ['OR.PA', "L'Oréal"], ['RMS.PA', 'Hermès'], ['TTE.PA', 'TotalEnergies', 'TTE'], ['SAN.PA', 'Sanofi', 'SNY'], ['AIR.PA', 'Airbus'], ['BNP.PA', 'BNP Paribas'],
  ['SU.PA', 'Schneider Electric'], ['AI.PA', 'Air Liquide'], ['CS.PA', 'AXA'], ['EL.PA', 'EssilorLuxottica'],
  ['ASML.AS', 'ASML Holding', 'ASML'], ['ADYEN.AS', 'Adyen'], ['INGA.AS', 'ING Group', 'ING'], ['PRX.AS', 'Prosus'], ['HEIA.AS', 'Heineken'],
  ['NESN.SW', 'Nestlé'], ['ROG.SW', 'Roche'], ['NOVN.SW', 'Novartis', 'NVS'], ['UBSG.SW', 'UBS Group', 'UBS'], ['ZURN.SW', 'Zurich Insurance'], ['CFR.SW', 'Richemont'],
  ['NOVO-B.CO', 'Novo Nordisk', 'NVO'], ['VOLV-B.ST', 'Volvo'], ['ERIC-B.ST', 'Ericsson', 'ERIC'], ['EQNR.OL', 'Equinor', 'EQNR'],
  ['ENI.MI', 'Eni', 'E'], ['ISP.MI', 'Intesa Sanpaolo'], ['UCG.MI', 'UniCredit'], ['RACE.MI', 'Ferrari', 'RACE'], ['ENEL.MI', 'Enel'],
  ['SAN.MC', 'Banco Santander', 'SAN'], ['ITX.MC', 'Inditex'], ['IBE.MC', 'Iberdrola'], ['BBVA.MC', 'BBVA', 'BBVA'],
  // Hong Kong
  ['0700.HK', 'Tencent'], ['9988.HK', 'Alibaba Group', 'BABA'], ['3690.HK', 'Meituan'], ['1299.HK', 'AIA Group'], ['0005.HK', 'HSBC Holdings (HK)', 'HSBC'],
  ['0939.HK', 'China Construction Bank'], ['1398.HK', 'ICBC'], ['2318.HK', 'Ping An Insurance'], ['0941.HK', 'China Mobile'], ['1810.HK', 'Xiaomi'],
  ['9618.HK', 'JD.com', 'JD'], ['1211.HK', 'BYD Company'], ['0388.HK', 'Hong Kong Exchanges & Clearing'], ['9999.HK', 'NetEase', 'NTES'], ['9888.HK', 'Baidu', 'BIDU'],
  ['2020.HK', 'Anta Sports'], ['0883.HK', 'CNOOC'], ['1024.HK', 'Kuaishou'], ['9868.HK', 'XPeng', 'XPEV'], ['2015.HK', 'Li Auto', 'LI'],
  // Mainland China (A-shares)
  ['600519.SS', 'Kweichow Moutai'], ['601318.SS', 'Ping An Insurance (A)'], ['600036.SS', 'China Merchants Bank'], ['601398.SS', 'ICBC (A)'], ['600900.SS', 'China Yangtze Power'],
  ['601857.SS', 'PetroChina'], ['688981.SS', 'SMIC'], ['300750.SZ', 'CATL (Contemporary Amperex)'], ['002594.SZ', 'BYD (A)'], ['000858.SZ', 'Wuliangye Yibin'],
  ['000333.SZ', 'Midea Group'], ['000001.SZ', 'Ping An Bank'], ['002415.SZ', 'Hikvision'], ['300059.SZ', 'East Money Information'],
  // Japan
  ['7203.T', 'Toyota Motor', 'TM'], ['6758.T', 'Sony Group', 'SONY'], ['9984.T', 'SoftBank Group'], ['8306.T', 'Mitsubishi UFJ Financial', 'MUFG'], ['6861.T', 'Keyence'],
  ['9983.T', 'Fast Retailing (Uniqlo)'], ['7974.T', 'Nintendo'], ['8035.T', 'Tokyo Electron'], ['6501.T', 'Hitachi'], ['9432.T', 'NTT'], ['4063.T', 'Shin-Etsu Chemical'],
  ['7267.T', 'Honda Motor', 'HMC'], ['6098.T', 'Recruit Holdings'], ['8058.T', 'Mitsubishi Corp'],
  // Korea / Taiwan
  ['005930.KS', 'Samsung Electronics'], ['000660.KS', 'SK Hynix'], ['373220.KS', 'LG Energy Solution'], ['005380.KS', 'Hyundai Motor'], ['035420.KS', 'Naver'],
  ['2330.TW', 'TSMC (Taiwan Semiconductor)', 'TSM'], ['2317.TW', 'Hon Hai (Foxconn)'], ['2454.TW', 'MediaTek'], ['2308.TW', 'Delta Electronics'],
  // India
  ['RELIANCE.NS', 'Reliance Industries'], ['TCS.NS', 'Tata Consultancy Services'], ['HDFCBANK.NS', 'HDFC Bank', 'HDB'], ['INFY.NS', 'Infosys', 'INFY'], ['ICICIBANK.NS', 'ICICI Bank', 'IBN'],
  ['BHARTIARTL.NS', 'Bharti Airtel'], ['SBIN.NS', 'State Bank of India'], ['ITC.NS', 'ITC'], ['LT.NS', 'Larsen & Toubro'], ['HINDUNILVR.NS', 'Hindustan Unilever'],
  ['BAJFINANCE.NS', 'Bajaj Finance'], ['MARUTI.NS', 'Maruti Suzuki'], ['WIPRO.NS', 'Wipro', 'WIT'], ['ADANIENT.NS', 'Adani Enterprises'],
  // Canada / Australia / Singapore
  ['SHOP.TO', 'Shopify', 'SHOP'], ['RY.TO', 'Royal Bank of Canada', 'RY'], ['TD.TO', 'Toronto-Dominion Bank', 'TD'], ['ENB.TO', 'Enbridge', 'ENB'], ['CNR.TO', 'Canadian National Railway', 'CNI'],
  ['CP.TO', 'Canadian Pacific Kansas City', 'CP'], ['BN.TO', 'Brookfield Corp', 'BN'], ['BMO.TO', 'Bank of Montreal', 'BMO'], ['BNS.TO', 'Scotiabank', 'BNS'], ['CSU.TO', 'Constellation Software'],
  ['BHP.AX', 'BHP Group', 'BHP'], ['CBA.AX', 'Commonwealth Bank'], ['CSL.AX', 'CSL'], ['NAB.AX', 'National Australia Bank'], ['WBC.AX', 'Westpac'], ['ANZ.AX', 'ANZ Group'],
  ['WES.AX', 'Wesfarmers'], ['MQG.AX', 'Macquarie Group'], ['FMG.AX', 'Fortescue'], ['WDS.AX', 'Woodside Energy', 'WDS'], ['TLS.AX', 'Telstra'],
  ['D05.SI', 'DBS Group'], ['O39.SI', 'OCBC Bank'], ['U11.SI', 'UOB'], ['Z74.SI', 'Singtel'],
  // Latin America / Africa / Middle East
  ['PETR4.SA', 'Petrobras', 'PBR'], ['VALE3.SA', 'Vale', 'VALE'], ['ITUB4.SA', 'Itaú Unibanco', 'ITUB'], ['BBDC4.SA', 'Banco Bradesco', 'BBD'], ['ABEV3.SA', 'Ambev', 'ABEV'], ['WEGE3.SA', 'WEG'],
  ['WALMEX.MX', 'Walmart de México'], ['GFNORTEO.MX', 'Grupo Financiero Banorte'],
  ['NPN.JO', 'Naspers'], ['FSR.JO', 'FirstRand'], ['SBK.JO', 'Standard Bank'], ['MTN.JO', 'MTN Group'],
  ['2222.SR', 'Saudi Aramco'], ['1120.SR', 'Al Rajhi Bank'], ['2010.SR', 'SABIC'],
].map(([symbol, name, adr]) => ({ symbol, name, adr: adr || null }));
export const ADR_OF = Object.fromEntries(WORLD.filter((x) => x.adr).map((x) => [x.symbol, x.adr]));
