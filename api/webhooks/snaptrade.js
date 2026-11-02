// Vercel — SnapTrade webhook receiver (POST, signature-verified). Sends fill alerts via your notify channels.
import { handleSnaptradeWebhook } from '../../lib/live.js';
export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await handleSnaptradeWebhook(Buffer.concat(chunks).toString('utf8'), req.headers);
  res.status(r.status).setHeader('Content-Type', 'application/json'); res.send(r.body);
}
