import express from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { q, audit } from '../db.js';
import { page, esc, rupees } from '../views/html.js';
import { sign, verify, normaliseEmail, hashId } from '../lib/crypto.js';
import { emails } from '../integrations/email.js';
import { creatorLinks } from '../integrations/shopify.js';
import { isValidIfsc, isValidVpa } from '../lib/rules.js';
import { changePayoutDetails } from '../services/payouts.js';

export const dashboard = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const cookieOpts = { httpOnly: true, secure: config.env === 'production', sameSite: 'lax', maxAge: 30 * 86400 * 1000 };

async function currentCreator(req) {
  const t = verify(req.cookies.session);
  if (!t || t.k !== 'session') return null;
  return (await q(`SELECT * FROM creators WHERE id=$1 AND status IN ('active','paused')`, [t.cid])).rows[0] || null;
}

dashboard.get('/login', async (req, res, next) => {
  try {
    if (req.query.t) {
      const t = verify(String(req.query.t));
      if (!t || t.k !== 'login') return res.send(page('Link expired', '<h1>This link has expired</h1><p><a class="btn" href="/login">Get a new link</a></p>'));
      res.cookie('session', sign({ cid: t.cid, k: 'session' }, 30 * 86400), cookieOpts);
      return res.redirect('/dashboard');
    }
    res.send(page('Sign in', `<h1>Sign in</h1><p>Enter the email you joined with. We will send you a link that works for 15 minutes.</p>
<form method="post" action="/login"><input class="hp" type="text" name="website" tabindex="-1" autocomplete="off">
<label>Email</label><input type="email" name="email" required><p><button class="btn" type="submit">Send my link</button></p></form>`));
  } catch (e) { next(e); }
});

dashboard.post('/login', limiter, express.urlencoded({ extended: false }), async (req, res, next) => {
  try {
    const email = normaliseEmail(req.body.email);
    if (email && !req.body.website) {
      const c = (await q(`SELECT id, email FROM creators WHERE email_hash=$1 AND status IN ('active','paused')`, [hashId(email)])).rows[0];
      if (c) await emails.magicLink(c.email, `${config.baseUrl}/login?t=${sign({ cid: c.id, k: 'login' }, 15 * 60)}`);
    }
    // Same answer either way, so the form can't be used to discover who has joined.
    res.send(page('Check your email', '<h1>Check your email</h1><p>If that address belongs to a Clockwork creator, a sign-in link is on its way.</p>'));
  } catch (e) { next(e); }
});

dashboard.post('/logout', (req, res) => { res.clearCookie('session'); res.redirect('/'); });

dashboard.get('/dashboard', async (req, res, next) => {
  try {
    const c = await currentCreator(req);
    if (!c) return res.redirect('/login');
    const a = (await q(
      `SELECT state, basis, count(*)::int AS n, coalesce(sum(commission_paise),0)::bigint AS paise
       FROM attributions WHERE creator_id=$1 GROUP BY state, basis`, [c.id])).rows;
    const sum = (states) => a.filter((r) => states.includes(r.state)).reduce((s, r) => s + Number(r.paise), 0);
    const count = (states) => a.filter((r) => states.includes(r.state)).reduce((s, r) => s + r.n, 0);
    const newCustomers = a.filter((r) => r.basis === 'flat' && !['reversed', 'rejected'].includes(r.state)).reduce((s, r) => s + r.n, 0);
    const monthOrders = (await q(
      `SELECT count(*)::int AS n FROM attributions WHERE creator_id=$1 AND state IN ('locked','qualifying','held')
       AND placed_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`, [c.id])).rows[0].n;
    const clicks = (await q(`SELECT count(*)::int AS n FROM clicks WHERE creator_id=$1 AND ts > now() - interval '30 days'`, [c.id])).rows[0].n;
    const orders = (await q(
      `SELECT order_name, placed_at, basis, rate_bps, commission_paise, state, reason FROM attributions
       WHERE creator_id=$1 ORDER BY placed_at DESC LIMIT 25`, [c.id])).rows;
    const payouts = (await q(
      `SELECT run_id, net_paise, tds_paise, carry_out_paise, status, utr, created_at FROM payouts WHERE creator_id=$1 ORDER BY created_at DESC LIMIT 12`, [c.id])).rows;
    const tiers = config.commission.tiers;
    const ti = tiers.findIndex((t) => t.name === c.tier);
    const next = tiers[ti + 1];
    const links = creatorLinks(c.code);
    const stateLabel = { pending: 'Awaiting payment or delivery', qualifying: 'In the 7-day window', locked: 'Earned', held: 'Under check', reversed: 'Cancelled or refunded', rejected: 'Not eligible' };

    res.send(page('Dashboard', `
${req.query.welcome ? '<div class="ok">Your email is confirmed and your code is live. Your welcome email has your links and the rules.</div>' : ''}
${c.status === 'paused' ? `<div class="err">Your participation is paused: ${esc(c.payments_held_reason || 'please check your email')}.</div>` : ''}
<h1>Hello ${esc(c.name)}</h1>
<p>Your code: <code>${esc(c.code)}</code> · Tier: ${esc(tiers[ti]?.label)}${c.level === 'spotlight' ? ' · Spotlight' : ''}</p>
<div class="stats">
<div class="stat"><b>${newCustomers}</b><span>New customers you brought</span></div>
<div class="stat"><b>${rupees(sum(['locked']))}</b><span>Earned and confirmed</span></div>
<div class="stat"><b>${rupees(sum(['pending', 'qualifying', 'held']))}</b><span>Pending (${count(['pending', 'qualifying', 'held'])} orders)</span></div>
<div class="stat"><b>${clicks}</b><span>Link clicks, last 30 days</span></div>
</div>
<div class="card">${next ? `<strong>${monthOrders} of ${next.minOrders}</strong> qualifying orders this month to reach ${esc(next.label)} (${next.rateBps / 100}% on repeat orders) from next month.` : 'You are at the top tier.'}
<br><span class="hint">New customers earn ₹300 each until 30 June 2027. Payments go out every Monday during the launch.</span></div>
<h2>Your links</h2>
<div class="card"><p><strong>Clockwork Daily</strong><br><code style="word-break:break-all">${esc(links.daily)}</code></p>
<p><strong>The whole range</strong><br><code style="word-break:break-all">${esc(links.shop)}</code></p>
<p class="hint">Disclose every post: Instagram's Paid partnership label, or #ad in the first lines of the caption.</p></div>
<h2>Recent orders</h2>
<div class="card"><table><tr><th>Order</th><th>Date</th><th>Basis</th><th>Status</th><th class="r">Earnings</th></tr>
${orders.map((o) => `<tr><td>${esc(o.order_name)}</td><td>${new Date(o.placed_at).toLocaleDateString('en-GB')}</td><td>${o.basis === 'flat' ? 'New customer' : o.basis === 'percent' ? `${o.rate_bps / 100}%` : '-'}</td><td>${esc(stateLabel[o.state] || o.state)}</td><td class="r">${rupees(o.commission_paise)}</td></tr>`).join('') || '<tr><td colspan="5">No orders yet.</td></tr>'}
</table></div>
<h2>Statements</h2>
<div class="card"><table><tr><th>Period</th><th>Status</th><th class="r">Tax deducted</th><th class="r">Amount</th><th>UTR</th></tr>
${payouts.map((p) => `<tr><td>${esc(p.run_id)}</td><td>${p.status === 'dry_run' ? 'Test calculation' : p.status === 'carried' ? 'Carried forward' : esc(p.status)}</td><td class="r">${rupees(p.tds_paise)}</td><td class="r">${rupees(p.carry_out_paise || p.net_paise)}</td><td>${esc(p.utr || '')}</td></tr>`).join('') || '<tr><td colspan="5">No statements yet.</td></tr>'}
</table></div>
<h2>Your details</h2>
<div class="card">PAN ending ${esc(c.pan_last4)} · ${c.payout_method === 'bank' ? 'Bank account' : 'UPI'} ending ${esc(c.payout_last4)}<br>
${c.payout_hold_until && new Date(c.payout_hold_until) > new Date() ? `<br><span class="hint">Payments to this account start after ${new Date(c.payout_hold_until) > new Date(Date.now() + 365 * 86400000) ? 'you update your details' : new Date(c.payout_hold_until).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.</span>` : ''}
<p><a href="/payout-details">Change payout details</a></p></div>
<form method="post" action="/logout"><button class="btn mint" type="submit">Sign out</button></form>`, { narrow: false }));
  } catch (e) { next(e); }
});

// Optional short link: logs a click, then sends the visitor to the store with the code applied.
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

function payoutForm(errors = []) {
  return page('Payout details', `<h1>Change payout details</h1>
${errors.length ? `<div class="err">${errors.map(esc).join('<br>')}</div>` : ''}
<p>For your security we email you about the change and wait 72 hours before paying to a new account.</p>
<form method="post" action="/payout-details"><input type="hidden" name="csrf" value="__CSRF__">
<label>Payout method</label><select name="payout_method"><option value="upi">UPI</option><option value="bank">Bank account</option></select>
<label>UPI ID (if UPI)</label><input type="text" name="vpa">
<label>Bank account number (if bank)</label><input type="text" name="account">
<label>IFSC (if bank)</label><input type="text" name="ifsc">
<p><button class="btn" type="submit">Save</button> <a href="/dashboard">Cancel</a></p></form>`);
}

dashboard.get('/payout-details', async (req, res, next) => {
  try {
    const c = await currentCreator(req);
    if (!c) return res.redirect('/login');
    res.send(payoutForm().replace('__CSRF__', esc(sign({ cid: c.id, k: 'csrf-payout' }, 3600))));
  } catch (e) { next(e); }
});

dashboard.post('/payout-details', limiter, express.urlencoded({ extended: false }), async (req, res, next) => {
  try {
    const c = await currentCreator(req);
    if (!c) return res.redirect('/login');
    const t = verify(req.body.csrf);
    if (!t || t.cid !== c.id || t.k !== 'csrf-payout') return res.status(400).send(page('Error', '<h1>Please try again</h1>'));
    let payout;
    if (req.body.payout_method === 'bank') {
      const account = String(req.body.account || '').replace(/\s/g, '');
      const ifsc = String(req.body.ifsc || '').toUpperCase().trim();
      if (!/^\d{9,18}$/.test(account) || !isValidIfsc(ifsc)) return res.status(400).send(payoutForm(['Enter a valid bank account number and IFSC.']).replace('__CSRF__', esc(req.body.csrf)));
      payout = { method: 'bank', account, ifsc, key: `${account}@${ifsc}`, last4: account.slice(-4) };
    } else {
      const vpa = String(req.body.vpa || '').trim().toLowerCase();
      if (!isValidVpa(vpa)) return res.status(400).send(payoutForm(['Enter a valid UPI ID, for example name@okhdfcbank.']).replace('__CSRF__', esc(req.body.csrf)));
      payout = { method: 'upi', vpa, key: vpa, last4: vpa.split('@')[0].slice(-4) };
    }
    const r = await changePayoutDetails(c, payout);
    if (!r.ok) return res.status(400).send(payoutForm([r.reason]).replace('__CSRF__', esc(req.body.csrf)));
    res.redirect('/dashboard');
  } catch (e) { next(e); }
});
