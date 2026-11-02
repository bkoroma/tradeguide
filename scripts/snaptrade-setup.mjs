// One-time setup for SnapTrade COMMERCIAL keys: registers your SnapTrade user and prints
// SNAPTRADE_USER_ID / SNAPTRADE_USER_SECRET to put in your environment.
// (Personal API keys don't need this.)
//   SNAPTRADE_CLIENT_ID=... SNAPTRADE_CONSUMER_KEY=... npm run setup:snaptrade
import { Snaptrade, SnaptradeAuth } from 'snaptrade-typescript-sdk';
import { randomUUID } from 'node:crypto';

const clientId = process.env.SNAPTRADE_CLIENT_ID, consumerKey = process.env.SNAPTRADE_CONSUMER_KEY;
if (!clientId || !consumerKey) { console.error('Set SNAPTRADE_CLIENT_ID and SNAPTRADE_CONSUMER_KEY first.'); process.exit(1); }
const sdk = new Snaptrade({ auth: SnaptradeAuth.commercialApiKey({ clientId, consumerKey }) });
const userId = process.env.SNAPTRADE_USER_ID || `tradeguide-${randomUUID()}`;
try {
  const { data } = await sdk.authentication.registerSnapTradeUser({ userId });
  console.log('\nAdd these to your environment (keep the secret private):\n');
  console.log(`SNAPTRADE_USER_ID=${data.userId}`);
  console.log(`SNAPTRADE_USER_SECRET=${data.userSecret}\n`);
  console.log('Then open TradeGuide → Portfolio → Connect brokerage.');
} catch (e) {
  console.error('Registration failed:', e?.responseBody || e?.message || e);
  process.exit(1);
}
