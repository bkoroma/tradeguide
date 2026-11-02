// TradeGuide — request signing for direct broker APIs (Node built-in crypto only).
import { createPrivateKey, createHmac, randomBytes, sign as cryptoSign, timingSafeEqual } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// Ed25519 private key from a base64 seed (32 bytes) or seed+public (64 bytes)
export function ed25519FromBase64(b64) {
  const raw = Buffer.from(String(b64).trim(), 'base64');
  if (raw.length !== 32 && raw.length !== 64) throw new Error(`Ed25519 private key must be 32 or 64 bytes (got ${raw.length}).`);
  const seed = raw.subarray(0, 32);
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]); // PKCS#8 wrapper
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

// ---------- Robinhood Crypto Trading API ----------
// x-signature = base64( Ed25519( api_key + timestamp + path(with query) + METHOD + body ) )
export function robinhoodHeaders({ apiKey, privateKey, method, path, body = '', now = Date.now() }) {
  const ts = String(Math.floor(now / 1000));
  const msg = `${apiKey}${ts}${path}${method.toUpperCase()}${body}`;
  const sig = cryptoSign(null, Buffer.from(msg), privateKey).toString('base64');
  return { 'x-api-key': apiKey, 'x-timestamp': ts, 'x-signature': sig, 'Content-Type': 'application/json; charset=utf-8' };
}

// ---------- Coinbase CDP JWT (Advanced Trade) ----------
// REST: uri = "GET api.coinbase.com/api/v3/brokerage/accounts"; WebSocket: no uri. Valid 120 s.
export function coinbaseJwt({ keyName, secret, uri, now = Date.now() }) {
  const s = String(secret).replace(/\\n/g, '\n').trim();
  let alg, key;
  if (s.includes('BEGIN')) { alg = 'ES256'; key = createPrivateKey(s); }
  else { alg = 'EdDSA'; key = ed25519FromBase64(s); }
  const t = Math.floor(now / 1000);
  const header = { alg, kid: keyName, nonce: randomBytes(16).toString('hex'), typ: 'JWT' };
  const payload = { sub: keyName, iss: 'cdp', nbf: t, exp: t + 120, ...(uri ? { uri } : {}) };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = alg === 'ES256'
    ? cryptoSign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }) // JWS needs raw r||s, not DER
    : cryptoSign(null, Buffer.from(input), key);
  return `${input}.${b64url(sig)}`;
}

// ---------- SnapTrade webhook verification ----------
// SnapTrade signs JSON serialized with sorted keys and compact separators (Python json.dumps(sort_keys=True,
// separators=(",", ":")), ASCII-escaped). We re-serialize the raw body that way, keeping number literals exactly.
export function canonicalJson(raw) {
  let i = 0;
  const ws = () => { while (i < raw.length && ' \t\n\r'.includes(raw[i])) i++; };
  const str = () => { const start = i; i++; while (raw[i] !== '"') { if (raw[i] === '\\') i++; i++; if (i > raw.length) throw new Error('bad string'); } i++; return JSON.parse(raw.slice(start, i)); };
  const val = () => {
    ws();
    const c = raw[i];
    if (c === '{') {
      i++; const o = []; ws();
      if (raw[i] === '}') { i++; return { t: 'o', v: o }; }
      for (;;) { ws(); const k = str(); ws(); if (raw[i++] !== ':') throw new Error('bad object'); o.push([k, val()]); ws(); if (raw[i] === ',') { i++; continue; } if (raw[i++] !== '}') throw new Error('bad object'); return { t: 'o', v: o }; }
    }
    if (c === '[') {
      i++; const a = []; ws();
      if (raw[i] === ']') { i++; return { t: 'a', v: a }; }
      for (;;) { a.push(val()); ws(); if (raw[i] === ',') { i++; continue; } if (raw[i++] !== ']') throw new Error('bad array'); return { t: 'a', v: a }; }
    }
    if (c === '"') return { t: 's', v: str() };
    const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(raw.slice(i, i + 400));
    if (!m) throw new Error('bad token');
    i += m[0].length;
    return { t: 'l', v: m[0] };
  };
  const ascii = (s) => JSON.stringify(s).replace(/[\u007f-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')); // Python ensure_ascii escapes DEL too
  const out = (n) => {
    if (n.t === 'o') return '{' + [...n.v].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => ascii(k) + ':' + out(v)).join(',') + '}';
    if (n.t === 'a') return '[' + n.v.map(out).join(',') + ']';
    if (n.t === 's') return ascii(n.v);
    if (/^-?\d/.test(n.v) && /[.eE]/.test(n.v)) return pyFloat(Number(n.v));
    return n.v;
  };
  const root = val(); ws();
  if (i !== raw.length) throw new Error('trailing data');
  return out(root);
}

// Python float repr: shortest round-trip digits; scientific when exponent < -4 or >= 16; always has '.0' or exponent
export function pyFloat(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x > 0 ? 'Infinity' : '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mant, expS] = Math.abs(x).toExponential().split('e');
  const e = +expS, digits = mant.replace('.', ''), sign = x < 0 ? '-' : '';
  if (e < -4 || e >= 16) return `${sign}${digits[0]}${digits.length > 1 ? '.' + digits.slice(1) : ''}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  let out;
  if (e >= 0) { const int = digits.slice(0, e + 1).padEnd(e + 1, '0'), frac = digits.slice(e + 1); out = `${int}.${frac || '0'}`; }
  else out = `0.${'0'.repeat(-e - 1)}${digits}`;
  return sign + out;
}

export function verifySnaptradeSignature(rawBody, signature, consumerKey) {
  if (!signature || !consumerKey) return false;
  const given = Buffer.from(String(signature).trim());
  const check = (content) => { const exp = Buffer.from(createHmac('sha256', consumerKey).update(content).digest('base64')); return exp.length === given.length && timingSafeEqual(exp, given); };
  try { if (check(canonicalJson(rawBody))) return true; } catch { /* fall through */ }
  return check(rawBody); // tolerate a sender that signs the raw body
}

// ---------- Short-lived ticket for EventSource (which cannot send Authorization headers) ----------
export function makeTicket(secret, ttlSec = 60, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlSec;
  return `${exp}.${b64url(createHmac('sha256', secret).update(`live:${exp}`).digest())}`;
}
export function checkTicket(secret, ticket, now = Date.now()) {
  const [exp, sig] = String(ticket || '').split('.');
  if (!secret || !exp || !sig || +exp < Math.floor(now / 1000)) return false;
  const a = Buffer.from(sig), b = Buffer.from(b64url(createHmac('sha256', secret).update(`live:${exp}`).digest()));
  return a.length === b.length && timingSafeEqual(a, b);
}
