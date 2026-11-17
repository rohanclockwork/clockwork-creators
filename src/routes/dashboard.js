// JSON API for /pages/creator-dashboard on clockworkrituals.com. Sessions are signed bearer tokens the page keeps
// in the browser; the sign-in link (from email) is exchanged for one.
import express from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { q } from '../db.js';
import { sign, verify, normaliseEmail, hashId } from '../lib/crypto.js';
import { emails } from '../integrations/email.js';
import { creatorLinks } from '../integrations/shopify.js';
import { isValidIfsc, isValidVpa } from '../lib/rules.js';
import { changePayoutDetails } from '../services/payouts.js';
import { storePage } from './join.js';

export const dashboard = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const SESSION_DAYS = 30;

async function currentCreator(req) {
  const h = req.get('Authorization') || '';
  const t = verify(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!t || t.k !== 'session') return null;
  return (await q(`SELECT * FROM creators WHERE id=$1 AND status IN ('active','paused')`, [t.cid])).rows[0] || null;
}

dashboard.post('/api/login', limiter, express.json({ limit: '5kb' }), async (req, res, next) => {
  try {
    const email = normaliseEmail(req.body?.email);
    if (email && !req.body?.website) {
      const c = (await q(`SELECT id, email FROM creators WHERE email_hash=$1 AND status IN ('active','paused')`, [hashId(email)])).rows[0];
      if (c) await emails.magicLink(c.email, storePage('creator-dashboard', { t: sign({ cid: c.id, k: 'login' }, 15 * 60) }));
    }
    res.json({ ok: true }); // same answer either way, so the form can't reveal who has joined
  } catch (e) { next(e); }
});

dashboard.post('/api/session', limiter, express.json({ limit: '5kb' }), async (req, res) => {
  const t = verify(String(req.body?.t || ''));
  if (!t || t.k !== 'login') return res.status(401).json({ error: 'expired' });
  res.json({ session: sign({ cid: t.cid, k: 'session' }, SESSION_DAYS * 86400) });
});

dashboard.get('/api/me', async (req, res, next) => {
  try {
    const c = await currentCreator(req);
    if (!c) return res.status(401).json({ error: 'signed_out' });
    const a = (await q(`SELECT state, basis, count(*)::int AS n, coalesce(sum(commission_paise),0)::bigint AS paise FROM attributions WHERE creator_id=$1 GROUP BY state, basis`, [c.id])).rows;
    const sum = (states) => a.filter((r) => states.includes(r.state)).reduce((s, r) => s + Number(r.paise), 0);
    const count = (states) => a.filter((r) => states.includes(r.state)).reduce((s, r) => s + r.n, 0);
    const monthOrders = (await q(
      `SELECT count(*)::int AS n FROM attributions WHERE creator_id=$1 AND state IN ('locked','qualifying','held')
       AND placed_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`, [c.id])).rows[0].n;
    const clicks = (await q(`SELECT count(*)::int AS n FROM clicks WHERE creator_id=$1 AND ts > now() - interval '30 days'`, [c.id])).rows[0].n;
    const orders = (await q(`SELECT order_name, placed_at, basis, rate_bps, commission_paise, state FROM attributions WHERE creator_id=$1 ORDER BY placed_at DESC LIMIT 25`, [c.id])).rows;
    const payouts = (await q(
      `SELECT run_id, net_paise, tds_paise, carry_out_paise, status, utr, created_at FROM payouts
       WHERE creator_id=$1 AND status <> 'dry_run' AND run_id NOT LIKE 'test-%' ORDER BY created_at DESC LIMIT 12`, [c.id])).rows;
    const tiers = config.commission.tiers;
    const ti = Math.max(0, tiers.findIndex((t) => t.name === c.tier));
    const next = tiers[ti + 1];
    const links = creatorLinks(c.code);
    const hold = c.payout_hold_until && new Date(c.payout_hold_until) > new Date() ? c.payout_hold_until : null;
    const stateLabel = { pending: 'Awaiting payment or delivery', qualifying: 'In the 7-day window', locked: 'Earned', held: 'Under check', reversed: 'Cancelled or refunded', rejected: 'Not eligible' };
    res.json({
      name: c.name, code: c.code, level: c.level, status: c.status, pausedReason: c.status === 'paused' ? c.payments_held_reason : null,
      tier: tiers[ti].label, next: next ? { label: next.label, minOrders: next.minOrders, ratePercent: next.rateBps / 100 } : null,
      monthOrders,
      stats: {
        newCustomers: a.filter((r) => r.basis === 'flat' && !['reversed', 'rejected', 'pending'].includes(r.state)).reduce((s, r) => s + r.n, 0),
        earnedPaise: sum(['locked']),
        pendingPaise: sum(['pending', 'qualifying', 'held']),
        pendingOrders: count(['pending', 'qualifying', 'held']),
        clicks30d: clicks,
      },
      links: { daily: links.daily, shop: links.shop, short: `${config.baseUrl}/go/${c.code}` },
      orders: orders.map((o) => ({
        name: o.order_name, date: o.placed_at, basis: o.basis === 'flat' ? 'New customer' : o.basis === 'percent' ? `${o.rate_bps / 100}%` : '-',
        status: stateLabel[o.state] || o.state, earnedPaise: o.commission_paise,
      })),
      payouts: payouts.map((p) => ({
        period: p.run_id, status: p.status === 'carried' ? 'Carried forward' : p.status === 'processed' ? 'Paid' : p.status === 'reversed' ? 'Returned by bank' : 'On its way',
        amountPaise: p.carry_out_paise || p.net_paise, tdsPaise: p.tds_paise, utr: p.utr,
      })),
      payout: {
        method: c.payout_method === 'bank' ? 'Bank account' : 'UPI', last4: c.payout_last4, panLast4: c.pan_last4,
        holdUntil: hold, holdIndefinite: Boolean(hold && new Date(hold) > new Date(Date.now() + 365 * 86400000)),
      },
    });
  } catch (e) { next(e); }
});

dashboard.post('/api/payout-details', limiter, express.json({ limit: '5kb' }), async (req, res, next) => {
  try {
    const c = await currentCreator(req);
    if (!c) return res.status(401).json({ error: 'signed_out' });
    const b = req.body || {};
    let payout;
    if (b.payout_method === 'bank') {
      const account = String(b.account || '').replace(/\s/g, '');
      const ifsc = String(b.ifsc || '').toUpperCase().trim();
      if (!/^\d{9,18}$/.test(account) || !isValidIfsc(ifsc)) return res.status(400).json({ errors: ['Enter a valid bank account number and IFSC.'] });
      payout = { method: 'bank', account, ifsc, key: `${account}@${ifsc}`, last4: account.slice(-4) };
    } else {
      const vpa = String(b.vpa || '').trim().toLowerCase();
      if (!isValidVpa(vpa)) return res.status(400).json({ errors: ['Enter a valid UPI ID, for example name@okhdfcbank.'] });
      payout = { method: 'upi', vpa, key: vpa, last4: vpa.split('@')[0].slice(-4) };
    }
    const r = await changePayoutDetails(c, payout);
    if (!r.ok) return res.status(400).json({ errors: [r.reason] });
    res.json({ ok: true, holdUntil: r.holdUntil });
  } catch (e) { next(e); }
});

// Short link: logs a click, then sends the visitor to the store with the code applied.
dashboard.get('/go/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code).toUpperCase();
    const c = (await q(`SELECT id, code FROM creators WHERE code=$1 AND status='active'`, [code])).rows[0];
    if (!c) return res.redirect(config.storeUrl);
    await q('INSERT INTO clicks (creator_id, ip_hash, ua, referer, landing) VALUES ($1,$2,$3,$4,$5)',
      [c.id, hashId(req.ip), String(req.get('user-agent') || '').slice(0, 300), String(req.get('referer') || '').slice(0, 300), 'daily']);
    res.redirect(302, creatorLinks(c.code).daily);
  } catch (e) { next(e); }
});
