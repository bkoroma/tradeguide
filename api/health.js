// Vercel Serverless Function — /api/health
import { handleApi } from '../lib/market.js';
export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const r = await handleApi('/api/health', url.searchParams);
  res.status(r.status); for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v); res.send(r.body);
}
