import express from 'express';
import cookieParser from 'cookie-parser';
import cron from 'node-cron';
import { config, requireSecrets } from './config.js';
import { migrate } from './migrate.js';
import { join } from './routes/join.js';
import { dashboard } from './routes/dashboard.js';
import { webhooks } from './routes/webhooks.js';
import { page } from './views/html.js';
import * as jobs from './jobs/index.js';

requireSecrets(['DATA_ENCRYPTION_KEY', 'SIGNING_KEY', 'HASH_PEPPER']);
await migrate();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Frame-Options', 'DENY');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(webhooks); // before any body parser: needs the raw body
app.use(cookieParser());
app.get('/health', (req, res) => res.json({ ok: true, dryRun: config.dryRun }));
app.use(join);
app.use(dashboard);
app.use((req, res) => res.status(404).send(page('Not found', '<h1>Page not found</h1><p><a href="/">Back to the start</a></p>')));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(page('Something went wrong', '<h1>Something went wrong</h1><p>Please try again in a few minutes. If it keeps happening, write to partners@clockworkrituals.com.</p>'));
});

app.listen(config.port, () => console.log(`clockwork-creators on :${config.port} (DRY_RUN=${config.dryRun})`));

if (config.schedulerEnabled) {
  const tz = { timezone: 'Asia/Kolkata' };
  const safe = (name, fn) => async () => { try { console.log(name, JSON.stringify(await fn())); } catch (e) { console.error(name, e); } };
  cron.schedule('30 2 * * *', safe('reconcile', jobs.reconcile), tz); // nightly 02:30
  cron.schedule('0 11 * * *', safe('posts', jobs.scanPosts), tz); // daily 11:00
  cron.schedule('30 0 1 * *', safe('tiers', jobs.monthlyTiers), tz); // 1st, 00:30
  cron.schedule('0 4 2 * *', safe('recheck', jobs.recheckCreators), tz); // 2nd, 04:00
  // Payouts: every Monday 10:00 during the campaign; the 5th at 10:00 afterwards.
  cron.schedule('0 10 * * 1', safe('payouts-weekly', async () => (new Date() <= new Date(config.commission.campaignEndsAt) ? jobs.payoutRun() : { skipped: 'campaign over' })), tz);
  cron.schedule('0 10 5 * *', safe('payouts-monthly', async () => (new Date() > new Date(config.commission.campaignEndsAt) ? jobs.payoutRun() : { skipped: 'weekly during campaign' })), tz);
  cron.schedule('0 9 * * 1', safe('summary', jobs.weeklySummary), tz); // Monday 09:00
}
