#!/usr/bin/env node
// TradeGuide Bot CLI
//   node bot/run.mjs              one scan (stocks only during US market hours; crypto always)
//   node bot/run.mjs --all        scan stocks + crypto regardless of the clock
//   node bot/run.mjs --dry        decide but don't send notifications (prints what would be sent)
//   node bot/run.mjs --loop       keep running on a schedule (BOT_INTERVAL_MIN, default 60)
//   node bot/run.mjs --test       send a test notification to every configured channel
import { runBot, startScheduler, sendTest } from '../lib/bot.js';

const args = new Set(process.argv.slice(2));
const pct = (x) => (x == null ? '  —  ' : `${(x * 100).toFixed(0).padStart(3)}%`);

if (args.has('--test')) {
  const r = await sendTest().catch((e) => { console.error(e.message); process.exit(1); });
  console.table(r); process.exit(r.every((x) => x.ok) ? 0 : 1);
} else if (args.has('--loop')) {
  startScheduler();
} else {
  const r = await runBot({ classes: args.has('--all') ? ['stock', 'crypto'] : undefined, dryRun: args.has('--dry') });
  if (r.skipped) { console.log(r.skipped); process.exit(0); }
  console.log(`\nScanned ${r.scanned} symbols (${r.classes.join(' + ')}) in ${r.ms} ms · state: ${r.store}${r.dryRun ? ' · DRY RUN' : ''}\n`);
  const rows = [...r.decisions].sort((a, b) => b.score - a.score);
  console.log('SYMBOL      ACTION  SCORE  P(up)  AUC   HIST   OOS     RISK  WHY');
  for (const d of rows) console.log(`${d.symbol.padEnd(11)} ${d.action.padEnd(6)} ${d.score.toFixed(0).padStart(5)}  ${pct(d.pUp)} ${d.auc == null ? ' —  ' : d.auc.toFixed(2)}  ${pct(d.analogsP)} ${d.oosRet == null ? '   —   ' : ((d.oosRet >= 0 ? '+' : '') + (d.oosRet * 100).toFixed(1) + '%').padStart(7)}  ${String(d.risk).padStart(4)}  ${d.reason}`);
  if (r.sent.length) { console.log('\nAlerts:'); for (const s of r.sent) console.log(`  ${s.title}  →  ${s.delivered.map((x) => `${x.channel}${x.ok ? '' : ' FAILED: ' + x.error}`).join(', ') || 'no channel configured (stored only)'}`); }
  else console.log('\nNo alerts this run.');
  if (r.errors.length) { console.log('\nErrors:'); r.errors.forEach((e) => console.log(`  ${e.symbol}: ${e.error}`)); }
}
