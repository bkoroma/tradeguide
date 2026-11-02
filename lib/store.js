// TradeGuide — bot state storage.
//   Default: JSON file (BOT_STATE_FILE, default ./data/bot-state.json) — Node server, VPS, GitHub Actions.
//   Serverless (Netlify/Vercel): Upstash Redis REST — UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (free tier).
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const env = (k) => (process.env[k] || '').trim();
const KEY = 'tradeguide:bot-state';

export function emptyState() {
  return { version: 1, symbols: {}, alerts: [], trades: [], lastRun: null, lastReport: null, lastDigestDay: null };
}

function upstash() {
  const url = env('UPSTASH_REDIS_REST_URL'), token = env('UPSTASH_REDIS_REST_TOKEN');
  if (!url || !token) return null;
  const call = async (path, body) => {
    const r = await fetch(`${url.replace(/\/$/, '')}${path}`, { method: body == null ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}` }, body });
    if (!r.ok) throw new Error(`Upstash HTTP ${r.status}`);
    return r.json();
  };
  return {
    kind: 'upstash',
    async load() { const j = await call(`/get/${KEY}`); return j.result ? JSON.parse(j.result) : emptyState(); },
    async save(s) { await call(`/set/${KEY}`, JSON.stringify(s)); },
  };
}

function file() {
  const path = resolve(env('BOT_STATE_FILE') || './data/bot-state.json');
  return {
    kind: 'file', path,
    async load() {
      try { return { ...emptyState(), ...JSON.parse(await readFile(path, 'utf8')) }; }
      catch (e) { if (e.code === 'ENOENT') return emptyState(); throw e; }
    },
    async save(s) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(s, null, 1));
      await rename(tmp, path); // atomic replace
    },
  };
}

export function getStore() { return upstash() || file(); }
