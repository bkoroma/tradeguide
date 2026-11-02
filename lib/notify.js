// TradeGuide — notification channels. Configure any combination with env vars:
//   Telegram:  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID           (best on iPhone/Android)
//   ntfy:      NTFY_TOPIC  [NTFY_SERVER=https://ntfy.sh] [NTFY_TOKEN]   (no account needed)
//   Discord:   DISCORD_WEBHOOK_URL
//   Email:     RESEND_API_KEY, ALERT_EMAIL_TO, ALERT_EMAIL_FROM
//   Webhook:   ALERT_WEBHOOK_URL   (receives the alert as JSON — Zapier/Make/IFTTT/Slack)

const env = (k) => (process.env[k] || '').trim();
const TIMEOUT = 10_000;

async function post(url, body, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { method: 'POST', body, headers, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 120)}`);
    return true;
  } finally { clearTimeout(t); }
}

const channels = {
  telegram: {
    on: () => !!(env('TELEGRAM_BOT_TOKEN') && env('TELEGRAM_CHAT_ID')),
    send: (m) => post(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/sendMessage`,
      JSON.stringify({ chat_id: env('TELEGRAM_CHAT_ID'), text: `${m.title}\n\n${m.body}${m.url ? `\n\n${m.url}` : ''}`, disable_web_page_preview: true }),
      { 'Content-Type': 'application/json' }),
  },
  ntfy: {
    on: () => !!env('NTFY_TOPIC'),
    send: (m) => {
      const h = { Title: asciiHeader(m.title), Tags: m.tags || 'chart_with_upwards_trend', Priority: m.priority || '3' };
      if (m.url) h.Click = m.url;
      if (env('NTFY_TOKEN')) h.Authorization = `Bearer ${env('NTFY_TOKEN')}`;
      return post(`${(env('NTFY_SERVER') || 'https://ntfy.sh').replace(/\/$/, '')}/${encodeURIComponent(env('NTFY_TOPIC'))}`, m.body, h);
    },
  },
  discord: {
    on: () => /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(env('DISCORD_WEBHOOK_URL')),
    send: (m) => post(env('DISCORD_WEBHOOK_URL'), JSON.stringify({ content: `**${m.title}**\n${m.body}${m.url ? `\n<${m.url}>` : ''}`.slice(0, 1900) }), { 'Content-Type': 'application/json' }),
  },
  email: {
    on: () => !!(env('RESEND_API_KEY') && env('ALERT_EMAIL_TO') && env('ALERT_EMAIL_FROM')),
    send: (m) => post('https://api.resend.com/emails', JSON.stringify({ from: env('ALERT_EMAIL_FROM'), to: env('ALERT_EMAIL_TO').split(',').map((s) => s.trim()), subject: m.title, text: `${m.body}${m.url ? `\n\n${m.url}` : ''}` }),
      { 'Content-Type': 'application/json', Authorization: `Bearer ${env('RESEND_API_KEY')}` }),
  },
  webhook: {
    on: () => /^https:\/\//.test(env('ALERT_WEBHOOK_URL')),
    send: (m) => post(env('ALERT_WEBHOOK_URL'), JSON.stringify({ title: m.title, text: m.body, url: m.url, alert: m.data || null }), { 'Content-Type': 'application/json' }),
  },
};

// HTTP headers must be Latin-1; strip emoji/symbols for ntfy titles
const asciiHeader = (s) => String(s).replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'TradeGuide';

export function configuredChannels() { return Object.entries(channels).filter(([, c]) => c.on()).map(([k]) => k); }

export async function notify(message) {
  const results = await Promise.all(Object.entries(channels).filter(([, c]) => c.on()).map(async ([k, c]) => {
    try { await c.send(message); return { channel: k, ok: true }; } catch (e) { return { channel: k, ok: false, error: e.message }; }
  }));
  return results;
}
