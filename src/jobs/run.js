// Run a job by hand: npm run job -- reconcile | backfill [since] | payouts | tiers | recheck | posts | summary | webhooks
import { pool } from '../db.js';
import { migrate } from '../migrate.js';
import { config } from '../config.js';
import * as jobs from './index.js';
import { subscribeWebhooks } from '../integrations/shopify.js';

const [name, arg] = process.argv.slice(2);
const map = {
  backfill: () => jobs.backfill(arg),
  reconcile: jobs.reconcile,
  payouts: () => jobs.payoutRun(new Date(), { force: arg === '--force' }),
  tiers: jobs.monthlyTiers,
  recheck: jobs.recheckCreators,
  posts: jobs.scanPosts,
  summary: jobs.weeklySummary,
  webhooks: () => subscribeWebhooks(config.baseUrl),
};
if (!map[name]) { console.log(`Jobs: ${Object.keys(map).join(', ')}`); process.exit(1); }
await migrate();
console.log(JSON.stringify(await map[name](), null, 2));
await pool.end();
