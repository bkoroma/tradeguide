// Netlify Function (v2) — /api/* (market data, broker, bot, live polling) + SnapTrade webhook receiver.
// Note: serverless can't hold the live WebSocket hub or SSE; the app falls back to polling /api/live/orders.
import { handleApi } from '../../lib/market.js';
export default async (req, context) => {
  const url = new URL(req.url);
  const headers = Object.fromEntries([...req.headers].map(([k, v]) => [k.toLowerCase(), v]));
  if (req.method === 'POST' && url.pathname === '/api/webhooks/snaptrade') {
    const { handleSnaptradeWebhook } = await import('../../lib/live.js');
    const r = await handleSnaptradeWebhook(await req.text(), headers);
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }
  if (req.method !== 'GET') return new Response(null, { status: 405 });
  const r = await handleApi(url.pathname, url.searchParams, { headers, ip: context?.ip || headers['x-nf-client-connection-ip'] || '' });
  return new Response(r.body, { status: r.status, headers: r.headers });
};
export const config = { path: ['/api/*', '/api/broker/*', '/api/bot/*', '/api/live/*', '/api/webhooks/*'] };
