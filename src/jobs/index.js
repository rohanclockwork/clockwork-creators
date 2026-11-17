import { config } from '../config.js';
import { q, tx, audit, withLock } from '../db.js';
import { ordersUpdatedSince, getOrder, deactivateDiscount } from '../integrations/shopify.js';
import { processOrder } from '../services/orders.js';
import { fetchAccount, refreshToken } from '../integrations/instagram.js';
import { qualify } from '../lib/qualify.js';
import { nextTier, fraudSignals, repeatCheck, tdsFor, financialYear } from '../lib/rules.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { emails, rupees } from '../integrations/email.js';
import * as rzp from '../integrations/razorpayx.js';
import { setupFundAccount } from '../services/payouts.js';

const DAY = 86400000;
const log = (...a) => console.log(new Date().toISOString(), ...a);

/** One-off: walk every order since the store opened so "new customer" is judged against all history. */
export async function backfill(since = '2024-01-01') {
  return withLock('backfill', async () => {
    let n = 0;
    for await (const o of ordersUpdatedSince(since, { createdSince: true })) { await processOrder(o); n++; }
    log(`backfill processed ${n} orders`);
    return { n };
  });
}

/** Nightly: re-read the last 45 days of orders, so a missed webhook never loses anyone money, and move orders through the 7-day window. */
export async function reconcile() {
  return withLock('reconcile', async () => {
    const since = new Date(Date.now() - 45 * DAY).toISOString();
    let n = 0;
    for await (const o of ordersUpdatedSince(since, { createdSince: true })) { await processOrder(o); n++; }
    // Older attributions still in flight (e.g. slow COD deliveries).
    const stale = await q(`SELECT order_id FROM attributions WHERE state IN ('pending','qualifying','held') AND placed_at < $1`, [since]);
    for (const r of stale.rows) { const o = await getOrder(r.order_id); if (o) await processOrder(o); }
    log(`reconcile processed ${n} recent and ${stale.rowCount} older orders`);
    return { n, older: stale.rowCount };
  });
}

/** 1st of the month: tiers from last month's qualifying orders, with one month's grace. */
export async function monthlyTiers(now = new Date()) {
  return withLock('tiers', async () => {
    const ist = new Date(now.getTime() + 5.5 * 3600000);
    const monthStart = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1));
    const prevStart = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1));
    const creators = (await q(`SELECT * FROM creators WHERE status IN ('active','paused')`)).rows;
    for (const c of creators) {
      const n = (await q(
        `SELECT count(*)::int AS n FROM attributions WHERE creator_id=$1 AND state IN ('locked','qualifying','held')
         AND placed_at >= ($2::timestamp AT TIME ZONE 'Asia/Kolkata') AND placed_at < ($3::timestamp AT TIME ZONE 'Asia/Kolkata')`,
        [c.id, prevStart.toISOString().slice(0, 10), monthStart.toISOString().slice(0, 10)])).rows[0].n;
      const r = nextTier({ current: c.tier, graceUntil: c.grace_until, lastMonthOrders: n, tiers: config.commission.tiers, monthStart: monthStart.toISOString().slice(0, 10) });
      if (r.tier !== c.tier || r.graceUntil !== (c.grace_until ? new Date(c.grace_until).toISOString().slice(0, 10) : null)) {
        await q('UPDATE creators SET tier=$2, grace_until=$3, tier_since=CASE WHEN tier<>$2 THEN $4::date ELSE tier_since END, updated_at=now() WHERE id=$1',
          [c.id, r.tier, r.graceUntil, monthStart.toISOString().slice(0, 10)]);
        await audit('system', 'creator', c.id, 'tier', { tier: c.tier }, { tier: r.tier, graceUntil: r.graceUntil, lastMonthOrders: n });
        if (r.changed) {
          const order = config.commission.tiers.map((t) => t.name);
          await emails.tierChanged(c.email, { name: c.name, tierLabel: config.commission.tiers.find((t) => t.name === r.tier).label, up: order.indexOf(r.tier) > order.indexOf(c.tier) });
        }
      }
    }
    return { creators: creators.length };
  });
}

/** Monthly: re-read every creator's Instagram; pause after two months below the bar. Also refreshes tokens. */
export async function recheckCreators() {
  return withLock('recheck', async () => {
    const creators = (await q(`SELECT * FROM creators WHERE status IN ('active','paused') AND ig_token_enc IS NOT NULL`)).rows;
    for (const c of creators) {
      try {
        let token = decrypt(c.ig_token_enc);
        const fresh = await refreshToken(token);
        token = fresh.token;
        const ig = await fetchAccount(token);
        const r = qualify(ig, config.qualification);
        const below = r.qualified ? 0 : c.below_bar_months + 1;
        await q(`UPDATE creators SET ig_token_enc=$2, ig_token_expires_at=$3, ig_snapshot=$4, below_bar_months=$5, updated_at=now() WHERE id=$1`,
          [c.id, encrypt(token), fresh.expiresAt, { ...r.metrics, reasons: r.reasons, checkedAt: new Date().toISOString() }, below]);
        if (below >= 2 && c.status === 'active') await pauseCreator(c, 'Your Instagram account has been below our criteria for two months in a row');
      } catch (e) {
        log(`recheck failed for creator ${c.id}: ${e.message}`);
        const expired = c.ig_token_expires_at && new Date(c.ig_token_expires_at) < new Date();
        if (expired && c.status === 'active') await pauseCreator(c, 'Your Instagram connection has expired. Sign in and reconnect Instagram to continue');
      }
    }
    return { creators: creators.length };
  });
}

async function pauseCreator(c, reason) {
  await q(`UPDATE creators SET status='paused', payments_held_reason=$2, updated_at=now() WHERE id=$1`, [c.id, reason]);
  if (c.shopify_discount_id) { try { await deactivateDiscount(c.shopify_discount_id); } catch (e) { log(e.message); } }
  await audit('system', 'creator', c.id, 'paused', { status: c.status }, { status: 'paused', reason });
  await emails.paused(c.email, { reason });
}

const DISCLOSURE = /(#ad\b|#sponsored\b|paid partnership)/i;
const BANNED = ['repairs', 'rebuilds', 'heals', 'reverses', 'cures', 'non-toxic', 'non toxic', 'chemical free', 'chemical-free',
  '100% natural', 'completely safe', 'safe to swallow', 'clinically proven', 'dentist recommended', 'patented',
  "india's #1", 'india’s #1', "india's first", 'puts minerals back', 'nano-hydroxyapatite %', 'fluoride is toxic', 'fluoride is poison'];

/** Daily: check creators' Clockwork posts for disclosure and banned claims. Captions only. */
export async function scanPosts() {
  return withLock('posts', async () => {
    const creators = (await q(`SELECT * FROM creators WHERE status='active' AND ig_token_enc IS NOT NULL`)).rows;
    for (const c of creators) {
      try {
        const ig = await fetchAccount(decrypt(c.ig_token_enc));
        const mentions = ig.posts.filter((p) => /clockwork/i.test(p.caption) || p.caption.toUpperCase().includes(c.code));
        for (const p of mentions) {
          const first = p.caption.slice(0, 125); // roughly what shows before "more"
          const disclosed = DISCLOSURE.test(first);
          const banned = BANNED.filter((b) => p.caption.toLowerCase().includes(b));
          const ok = disclosed && !banned.length;
          const prev = (await q('SELECT ok FROM post_checks WHERE media_id=$1', [p.id])).rows[0];
          const reel = ig.reels.find((r) => r.id === p.id);
          await q(`INSERT INTO post_checks (media_id, creator_id, permalink, posted_at, views, disclosed, banned_terms, ok) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                   ON CONFLICT (media_id) DO UPDATE SET views=$5, disclosed=$6, banned_terms=$7, ok=$8, checked_at=now()`,
          [p.id, c.id, p.permalink, p.timestamp, reel?.views ?? null, disclosed, banned, ok]);
          if (!ok && (!prev || prev.ok)) {
            const problems = [];
            if (!disclosed) problems.push('The paid relationship is not disclosed in the first lines of the caption. Add #ad, #sponsored or use the Paid partnership label.');
            if (banned.length) problems.push(`The caption uses wording we cannot allow: ${banned.join(', ')}.`);
            await emails.postProblem(c.email, { permalink: p.permalink, problems });
          }
        }
      } catch (e) { log(`post scan failed for creator ${c.id}: ${e.message}`); }
    }
    return { creators: creators.length };
  });
}

/** Before each payout: fraud holds and the repeat check. */
async function applyChecks(c, now) {
  const recent = (await q(`SELECT placed_at, pincode_hash, is_cod, state, reason FROM attributions WHERE creator_id=$1 AND placed_at > now() - interval '30 days'`, [c.id])).rows;
  const last24h = recent.filter((r) => now - new Date(r.placed_at) < DAY);
  const posted = (await q(`SELECT 1 FROM post_checks WHERE creator_id=$1 AND posted_at > now() - interval '48 hours'`, [c.id])).rowCount > 0;
  const signals = fraudSignals({ recent, last24h, postedRecently: posted, cfg: config.fraud });
  if (signals.length) {
    const held = await q(
      `UPDATE attributions SET state='held', hold_until=now() + make_interval(days => $2), reason=$3
       WHERE creator_id=$1 AND state='locked' AND paid_in_payout_id IS NULL AND (hold_until IS NULL) RETURNING order_id`,
      [c.id, config.fraud.extraHoldDays, signals.map((s) => s.code).join(',')]);
    if (held.rowCount) await emails.paused(c.email, { reason: `Some of your recent orders are under a routine check: ${signals.map((s) => s.message.toLowerCase()).join('; ')}. They are held for up to ${config.fraud.extraHoldDays} days.` });
  }
  // Release holds that have run their course; the nightly reconcile has already re-read those orders.
  await q(`UPDATE attributions SET state='locked', reason=NULL WHERE creator_id=$1 AND state='held' AND hold_until < now()`, [c.id]);

  if (!c.flat_rate_ended_at && c.active_since) {
    const firstOrders = (await q(
      `SELECT a.delivered_at, a.tubes,
         EXISTS (SELECT 1 FROM customer_orders co, customer_orders first
                 WHERE first.order_id = a.order_id AND co.order_id <> a.order_id AND co.placed_at > a.placed_at
                 AND ((first.email_hash IS NOT NULL AND co.email_hash = first.email_hash) OR (first.phone_hash IS NOT NULL AND co.phone_hash = first.phone_hash))) AS reordered
       FROM attributions a WHERE a.creator_id=$1 AND a.basis='flat' AND a.state IN ('locked','held')`, [c.id])).rows;
    const r = repeatCheck({ firstOrders, creatorSince: c.active_since, cfg: config.repeat, now });
    if (r.applies && !r.pass) {
      await q('UPDATE creators SET flat_rate_ended_at=now() WHERE id=$1', [c.id]);
      await audit('system', 'creator', c.id, 'flat_rate_ended', null, r);
      await emails.rateChanged(c.email, { name: c.name });
    }
  }
}

function runIdFor(now, weekly) {
  const ist = new Date(now.getTime() + 5.5 * 3600000);
  if (!weekly) {
    const prev = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1));
    return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Payout run. Weekly during the campaign, monthly (5th) after.
 * Three modes:
 *  - DRY_RUN=true: statements calculated and emailed to Rohan only. Nothing is marked paid, no money moves.
 *  - DRY_RUN=false with RazorpayX test keys: the full flow against RazorpayX test mode (run IDs start "test-").
 *  - DRY_RUN=false with live keys: real payouts. Each payout's reference and idempotency key is "<runId>-<creatorId>",
 *    and a run for a period that already exists is refused, so nobody is paid twice.
 */
// Runs of the same kind only: live runs never mix with test- or dry- runs.
const familySql = (param) => `(CASE WHEN ${param}::text = '' THEN run_id NOT LIKE 'dry-%' AND run_id NOT LIKE 'test-%' ELSE run_id LIKE ${param}::text || '%' END)`;

export async function payoutRun(now = new Date(), { force = false } = {}) {
  const live = !config.dryRun;
  if (live && !rzp.configured()) throw new Error('DRY_RUN is off but RazorpayX keys or account number are missing.');
  const testMode = live && rzp.isTestMode();
  const family = !live ? 'dry-' : testMode ? 'test-' : '';
  const campaignOn = now <= new Date(config.commission.campaignEndsAt);
  const weekly = campaignOn && config.payouts.weeklyDuringCampaign;
  const period = runIdFor(now, weekly);
  const runId = `${family}${period}`;
  const exists = await q('SELECT 1 FROM payout_runs WHERE run_id=$1', [runId]);
  if (exists.rowCount && !(force && !live)) return { refused: true, runId, message: 'A run for this period already exists. Never pay twice.' };
  if (exists.rowCount) { await q('DELETE FROM payouts WHERE run_id=$1', [runId]); await q('DELETE FROM payout_runs WHERE run_id=$1', [runId]); }
  await q(`INSERT INTO payout_runs (run_id, period_start, period_end, dry_run, test_mode) VALUES ($1, now() - interval '7 days', now(), $2, $3)`, [runId, !live, testMode]);

  const totals = { creators: 0, gross: 0, tds: 0, paid: 0, carried: 0, held: 0, failures: 0 };
  const lines = [];
  const creators = (await q(`SELECT * FROM creators WHERE status IN ('active','paused')`)).rows;
  const fy = financialYear(now);
  const label = new Date(now.getTime() + 5.5 * 3600000).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

  for (const c of creators) {
    try {
      await applyChecks(c, now);
      if (live && !c.rzp_fund_account_id && c.payout_enc) {
        try { const r = await setupFundAccount(c); if (r.fundAccountId) c.rzp_fund_account_id = r.fundAccountId; } catch (e) { log(`fund account retry failed for ${c.id}: ${e.message}`); }
      }
      const postHold = (await q('SELECT 1 FROM post_checks WHERE creator_id=$1 AND ok=false', [c.id])).rowCount > 0;
      const rows = postHold ? [] : (await q(
        `SELECT order_id, order_name, basis, rate_bps, commission_paise FROM attributions
         WHERE creator_id=$1 AND state='locked' AND paid_in_payout_id IS NULL ORDER BY placed_at`, [c.id])).rows;
      const gross = rows.reduce((s, r) => s + Number(r.commission_paise), 0);
      const adj = (await q(`SELECT id, amount_paise FROM adjustments WHERE creator_id=$1 AND applied_in_payout_id IS NULL AND written_off_at IS NULL`, [c.id])).rows;
      const adjustments = adj.reduce((s, a) => s + Number(a.amount_paise), 0);
      const carryIn = live ? Number((await q(
        `SELECT carry_out_paise FROM payouts WHERE creator_id=$1 AND ${familySql('$2')} AND status NOT IN ('dry_run','failed') ORDER BY created_at DESC LIMIT 1`,
        [c.id, family])).rows[0]?.carry_out_paise || 0) : 0;
      if (!gross && !adjustments && !carryIn) continue;

      const prior = (await q(`SELECT coalesce(sum(gross_paise),0)::bigint AS g, coalesce(sum(tds_paise),0)::bigint AS t FROM payouts
                              WHERE creator_id=$1 AND fy=$2 AND status NOT IN ('dry_run','failed') AND ${familySql('$3')}`, [c.id, fy, family])).rows[0];
      const tds = tdsFor({ creditedBeforePaise: Number(prior.g), tdsBeforePaise: Number(prior.t), grossNowPaise: gross, hasValidPan: Boolean(c.pan_enc), cfg: config.tds });
      const net = gross + adjustments + carryIn - tds;

      let holdReason = null;
      if (net < config.payouts.minPayoutPaise) holdReason = 'under_minimum';
      else if (live && c.payout_hold_until && new Date(c.payout_hold_until) > now) holdReason = 'details_changed';
      else if (live && !c.rzp_fund_account_id) holdReason = 'no_fund_account';
      else if (c.status === 'paused') holdReason = 'paused';

      const reference = `${runId}-${c.id}`;
      const status = !live ? 'dry_run' : holdReason ? 'carried' : 'queued';
      const carryOut = status === 'carried' || (!live && holdReason) ? net : 0;

      const payoutId = await tx(async (client) => {
        const ins = await client.query(
          `INSERT INTO payouts (run_id, creator_id, gross_paise, adjustments_paise, carry_in_paise, tds_paise, net_paise, carry_out_paise, status, fy, reference_id, mode)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (reference_id) DO NOTHING RETURNING id`,
          [runId, c.id, gross, adjustments, carryIn, tds, net, carryOut, status, fy, live ? reference : null,
            live && !holdReason ? rzp.payoutMode(c.payout_method, net) : null]);
        if (!ins.rowCount) return null; // already exists: never pay twice
        const id = ins.rows[0].id;
        if (live) {
          // Earnings and adjustments are credited into this statement whether paid now or carried.
          if (rows.length) await client.query('UPDATE attributions SET paid_in_payout_id=$2 WHERE order_id = ANY($1)', [rows.map((r) => r.order_id), id]);
          if (adj.length) await client.query('UPDATE adjustments SET applied_in_payout_id=$2 WHERE id = ANY($1)', [adj.map((a) => a.id), id]);
        }
        return id;
      });
      if (!payoutId) continue;

      totals.creators++; totals.gross += gross; totals.tds += tds;
      if (holdReason) { totals.carried += net; if (holdReason !== 'under_minimum') totals.held++; }

      let outcome = holdReason ? `carried (${holdReason.replace(/_/g, ' ')})` : live ? 'queued' : 'would pay';
      if (live && !holdReason) {
        try {
          const p = await rzp.createPayout({ fundAccountId: c.rzp_fund_account_id, amountPaise: net, method: c.payout_method, referenceId: reference, label });
          await q('UPDATE payouts SET rzp_payout_id=$2, status=$3, utr=$4 WHERE id=$1',
            [payoutId, p.id, ['processed', 'processing', 'queued', 'pending'].includes(p.status) ? (p.status === 'pending' ? 'queued' : p.status) : 'processing', p.utr || null]);
          totals.paid += net;
          outcome = p.status;
        } catch (e) {
          if (e.status && e.status >= 400 && e.status < 500) {
            // RazorpayX refused it: no money moved. Put everything back for the next run.
            await tx(async (client) => {
              await client.query(`UPDATE payouts SET status='failed', failure_reason=$2, carry_out_paise=0 WHERE id=$1`, [payoutId, e.message.slice(0, 300)]);
              await client.query('UPDATE attributions SET paid_in_payout_id=NULL WHERE paid_in_payout_id=$1', [payoutId]);
              await client.query('UPDATE adjustments SET applied_in_payout_id=NULL WHERE applied_in_payout_id=$1', [payoutId]);
            });
            outcome = 'refused by RazorpayX';
          } else {
            // Unknown outcome (timeout, 5xx): leave it marked so it can't be paid twice; Rohan checks the dashboard.
            await q(`UPDATE payouts SET status='processing', failure_reason=$2 WHERE id=$1`, [payoutId, `Outcome unknown: ${e.message}`.slice(0, 300)]);
            outcome = 'outcome unknown, check RazorpayX';
          }
          totals.failures++;
        }
      }

      if (live) {
        await emails.statement(c.email, {
          name: c.name, periodLabel: period, rows, gross, adjustments, carryIn, tds, net,
          carryOut: holdReason ? net : 0, dryRun: false, testMode,
        });
      }
      lines.push(`<tr><td>${c.code}</td><td>${rows.length}</td><td style="text-align:right">${rupees(gross)}</td><td style="text-align:right">${rupees(adjustments + carryIn)}</td><td style="text-align:right">${rupees(tds)}</td><td style="text-align:right">${rupees(net)}</td><td>${outcome}</td></tr>`);
    } catch (e) {
      totals.failures++;
      log(`payout run failed for creator ${c.id}: ${e.message}`);
      lines.push(`<tr><td>${c.code}</td><td colspan="6">Error: ${String(e.message).slice(0, 200)}</td></tr>`);
    }
  }
  await q(`UPDATE payout_runs SET status='finished', totals=$2, finished_at=now() WHERE run_id=$1`, [runId, totals]);
  const modeLabel = !live ? 'DRY_RUN, no money sent' : testMode ? 'RazorpayX TEST MODE' : 'LIVE';
  await emails.ownerDigest(`Creator payouts ${runId} (${modeLabel})`,
    `<p>Creators with a statement: ${totals.creators}<br>Earned: ${rupees(totals.gross)}<br>TDS withheld: ${rupees(totals.tds)}<br>
     ${live ? 'Sent to RazorpayX' : 'Would pay'}: ${rupees(live ? totals.paid : totals.gross - totals.tds - totals.carried)}<br>
     Carried forward: ${rupees(totals.carried)} (${totals.held} held for details change, pause or missing account)<br>Problems: ${totals.failures}</p>
     <table cellpadding="4" style="font-size:13px;border-collapse:collapse"><tr><th align="left">Code</th><th>Orders</th><th>Earned</th><th>Adj. and carry</th><th>TDS</th><th>Net</th><th>Outcome</th></tr>${lines.join('')}</table>
     ${!live ? '<p>Creators were not emailed. When these numbers look right, switch DRY_RUN off in Railway.</p>' : ''}`);
  return { runId, totals };
}

/** Quarterly: TDS details for the CA (deductee PAN, name, amount credited, TDS, date). Emailed to Rohan as a CSV. */
export async function tdsReport(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3600000);
  // The quarter that just ended.
  const m = ist.getUTCMonth();
  const qEnd = new Date(Date.UTC(ist.getUTCFullYear(), m - (m % 3), 1));
  const qStart = new Date(Date.UTC(qEnd.getUTCFullYear(), qEnd.getUTCMonth() - 3, 1));
  const rows = (await q(
    `SELECT p.created_at, p.gross_paise, p.tds_paise, p.run_id, c.pan_enc, c.pan_name, c.name
     FROM payouts p JOIN creators c ON c.id = p.creator_id
     WHERE p.status NOT IN ('dry_run','failed') AND p.run_id NOT LIKE 'test-%' AND p.run_id NOT LIKE 'dry-%'
       AND p.created_at >= $1 AND p.created_at < $2 ORDER BY p.created_at`, [qStart.toISOString(), qEnd.toISOString()])).rows;
  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['Deductee PAN,Name as on PAN,Amount credited (INR),TDS (INR),Date of credit,Section,Run'];
  for (const r of rows) {
    lines.push([decrypt(r.pan_enc), r.pan_name || r.name, (r.gross_paise / 100).toFixed(2), (r.tds_paise / 100).toFixed(2),
      new Date(r.created_at).toISOString().slice(0, 10), config.tds.sectionLabel, r.run_id].map(csvCell).join(','));
  }
  const label = `${qStart.toISOString().slice(0, 7)} to ${new Date(qEnd.getTime() - 86400000).toISOString().slice(0, 7)}`;
  await emails.ownerDigestWithAttachment(`Creator TDS for the CA, ${label}`,
    `<p>${rows.length} credits this quarter. The attached CSV has each creator's PAN, so forward it only to your CA.</p>`,
    { filename: `creator-tds-${qStart.toISOString().slice(0, 7)}.csv`, content: lines.join('\n') });
  return { rows: rows.length, label };
}

/** Weekly owner summary of sign-ups, orders and the halo estimate. */
export async function weeklySummary() {
  const s = (await q(`SELECT
      (SELECT count(*) FROM creators WHERE status='active')::int AS active,
      (SELECT count(*) FROM creators WHERE created_at > now() - interval '7 days' AND status IN ('active','pending_email'))::int AS joined,
      (SELECT count(*) FROM creators WHERE created_at > now() - interval '7 days' AND status='rejected')::int AS rejected,
      (SELECT count(*) FROM attributions WHERE placed_at > now() - interval '7 days')::int AS coded,
      (SELECT count(*) FROM attributions WHERE placed_at > now() - interval '7 days' AND basis='flat')::int AS new_customers,
      (SELECT count(*) FROM customer_orders WHERE placed_at > now() - interval '7 days')::int AS all_orders,
      (SELECT count(*) FROM customer_orders WHERE placed_at > now() - interval '35 days' AND placed_at <= now() - interval '7 days')::int AS prior4w,
      (SELECT coalesce(sum(views),0) FROM post_checks WHERE posted_at > now() - interval '7 days')::bigint AS views`)).rows[0];
  const baseline = Math.round(s.prior4w / 4);
  const uncoded = s.all_orders - s.coded;
  await emails.ownerDigest('Clockwork Creators: your week',
    `<p>Active creators: ${s.active}<br>Joined this week: ${s.joined} · Not approved: ${s.rejected}</p>
     <p>Orders through creator codes: ${s.coded} (${s.new_customers} new customers)<br>Views on creator posts about Clockwork: ${Number(s.views).toLocaleString('en-IN')}</p>
     <p>Website orders this week: ${s.all_orders}, against a weekly average of ${baseline} over the previous four weeks. Orders without a creator code: ${uncoded}.<br>
     <span style="color:#5b6360">This is an estimate of the halo, not exact attribution. Amazon orders are not included yet.</span></p>`);
  return s;
}
