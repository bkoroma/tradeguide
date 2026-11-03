// TradeGuide — Node server (Node 18+). Only dependency: SnapTrade SDK, loaded lazily if configured.
// Serves /public and the market-data API. Works locally, on a VPS, Render, Railway, Fly, etc.
//   node server.js                    → http://localhost:8787
//   node --env-file=.env server.js    → same, loading broker keys from .env (Node 20.6+)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './lib/market.js';

const PORT = Number(process.env.PORT) || 8787;
// Render provides the public URL automatically; use it for alert links and broker redirects unless APP_URL is set
if (!process.env.APP_URL && process.env.RENDER_EXTERNAL_URL) process.env.APP_URL = process.env.RENDER_EXTERNAL_URL;
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

// Simple per-IP rate limit for the API: 120 requests / minute
const hits = new Map();
function limited(ip) {
  const now = Date.now(), w = hits.get(ip) || { n: 0, reset: now + 60_000 };
  if (now > w.reset) { w.n = 0; w.reset = now + 60_000; }
  w.n++; hits.set(ip, w);
  if (hits.size > 5000) hits.clear();
  return w.n > 120;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    // SnapTrade webhooks (POST, signature-verified) — the only non-GET route
    if (req.method === 'POST' && url.pathname === '/api/webhooks/snaptrade') {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 256 * 1024) { res.writeHead(413).end(); return; } chunks.push(c); }
      const live = await import('./lib/live.js');
      const r = await live.handleSnaptradeWebhook(Buffer.concat(chunks).toString('utf8'), req.headers);
      res.writeHead(r.status, { 'Content-Type': 'application/json' }).end(r.body);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SECURITY).end(); return; }
    // Live trade stream (Server-Sent Events, ticket-authenticated)
    if (url.pathname === '/api/live/stream') { (await import('./lib/live.js')).handleSSE(req, res, url); return; }
    if (url.pathname.startsWith('/api/')) {
      const ip = (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0] : req.socket.remoteAddress || '').trim();
      if (limited(ip)) { res.writeHead(429, { ...SECURITY, 'Content-Type': 'application/json', 'Retry-After': '60' }).end('{"error":"Too many requests"}'); return; }
      const r = await handleApi(url.pathname, url.searchParams, { headers: req.headers, ip });
      res.writeHead(r.status, { ...SECURITY, ...r.headers }).end(r.body);
      return;
    }
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p.endsWith('/')) p += 'index.html';
    let file = join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(403, SECURITY).end(); return; }
    try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); } catch { file = join(ROOT, 'index.html'); } // SPA fallback
    const body = await readFile(file);
    const ext = extname(file);
    const cache = ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, { ...SECURITY, 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache }).end(req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    res.writeHead(500, { ...SECURITY, 'Content-Type': 'text/plain' }).end('Server error');
    console.error(e);
  }
});

server.listen(PORT, () => console.log(`TradeGuide running → http://localhost:${PORT}`));

// Load the full symbol universe (all US stocks/ETFs + USD crypto) in the background at boot
if (process.env.MARKET_DEMO !== '1') import('./lib/universe.js').then((u) => u.loadUniverse()).then((st) => console.log(`[universe] ${st.stocks.length} stocks/ETFs, ${st.crypto.length} crypto${st.errors.length ? ' — ' + st.errors.join('; ') : ''}`)).catch((e) => console.error('[universe]', e.message));

// Alert bot: runs inside this server when BOT_ENABLED=1 (always-on hosts: VPS, Render, Railway, Fly)
// Live trade hub: starts at boot when a broker and the access code are configured (LIVE_ENABLED=0 to disable)
if (process.env.LIVE_ENABLED !== '0' && (process.env.APP_ACCESS_TOKEN || '').trim().length >= 12) {
  import('./lib/brokers.js').then(async (b) => {
    if (b.status().some((p) => p.configured)) { const s = (await import('./lib/live.js')).startLive(); console.log(`[live] trade hub on — ${Object.keys(s.sources).join(', ') || 'no sources'}`); }
  }).catch((e) => console.error('[live] failed to start:', e));
}

if (process.env.BOT_ENABLED === '1') import('./lib/bot.js').then((b) => b.startScheduler()).catch((e) => console.error('[bot] failed to start:', e));
