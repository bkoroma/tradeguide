// Vercel — /api/live/:action (ticket | status | orders). Streaming SSE needs a long-running Node host.
import { handleApi } from '../lib/market.js';
export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const action = String(url.searchParams.get('action') || '').replace(/[^a-z]/g, '');
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const r = await handleApi('/api/live/' + action, url.searchParams, { headers: req.headers, ip });
  res.status(r.status); for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v); res.send(r.body);
}
