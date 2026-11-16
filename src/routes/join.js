import express from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { q, audit } from '../db.js';
import { page, esc } from '../views/html.js';
import { authorizeUrl, exchangeCode, fetchAccount } from '../integrations/instagram.js';
import { qualify } from '../lib/qualify.js';
import { encrypt, hashId, sign, verify, normaliseEmail, normalisePhone, normaliseAddress } from '../lib/crypto.js';
import { isValidPan, isValidIfsc, isValidVpa } from '../lib/rules.js';
import { emails } from '../integrations/email.js';
import { activate, cleanCode } from '../services/creators.js';

export const join = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const cookieOpts = { httpOnly: true, secure: config.env === 'production', sameSite: 'lax', maxAge: 60 * 60 * 1000 };
const ipHash = (req) => hashId(req.ip);

join.get('/', (req, res) => {
  res.send(page('Join', `
<h1>Earn with Clockwork</h1>
<p>Share Clockwork with your audience. Every new customer who orders through your code or link earns you ₹300, until 30 June 2027. Repeat orders earn 10%, rising to 15% and 20% as your orders grow. Your audience gets 10% off.</p>
<div class="card"><strong>How joining works</strong>
<ol><li>Connect your Instagram professional account. We check your followers, reach and audience automatically.</li>
<li>Add your details and payout account.</li><li>Confirm your email. Your code is ready in a minute.</li></ol>
<p class="hint">We read only your profile, reels and audience insights. We never post, comment or send messages. You need at least 3,000 followers, most of them in India.</p></div>
<p><a class="btn" href="/join">Connect Instagram</a></p>
<p class="hint">By joining you agree to the <a href="${esc(config.storeUrl)}/pages/creator-terms">Creator Terms</a>. Already a creator? <a href="/login">Sign in</a>.</p>`));
});

join.get('/join', limiter, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, { ...cookieOpts, maxAge: 10 * 60 * 1000 });
  res.redirect(authorizeUrl(state));
});

join.get('/auth/instagram/callback', limiter, async (req, res, next) => {
  try {
    if (!req.query.state || req.query.state !== req.cookies.oauth_state) {
      return res.status(400).send(page('Try again', '<h1>That link has expired</h1><p><a class="btn" href="/join">Connect Instagram again</a></p>'));
    }
    if (req.query.error) {
      return res.send(page('Not connected', '<h1>Instagram was not connected</h1><p>You can try again whenever you are ready.</p><p><a class="btn" href="/join">Connect Instagram</a></p>'));
    }
    const { token, expiresAt } = await exchangeCode(String(req.query.code));
    const ig = await fetchAccount(token);
    const prior = (await q('SELECT * FROM creators WHERE ig_user_id = $1', [ig.igUserId])).rows[0];

    if (prior && ['active', 'paused', 'pending_email'].includes(prior.status)) {
      return res.send(page('Already joined', `<h1>This account has already joined</h1><p><a class="btn" href="/login">Sign in to your dashboard</a></p>`));
    }
    if (prior?.status === 'suspended') {
      return res.send(page('Not eligible', '<h1>This account cannot join the programme</h1><p>Write to partners@clockworkrituals.com if you think this is a mistake.</p>'));
    }
    if (prior?.reapply_after && new Date(prior.reapply_after) > new Date()) {
      return res.send(page('Not yet', `<h1>You can apply again from ${new Date(prior.reapply_after).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</h1>`));
    }

    const result = qualify(ig, config.qualification);
    const snapshot = { ...result.metrics, level: result.level, reasons: result.reasons, checkedAt: new Date().toISOString(), accountType: ig.accountType };
    const reapply = new Date(Date.now() + config.qualification.reapplyAfterDays * 86400000);

    const row = (await q(
      `INSERT INTO creators (ig_user_id, ig_username, ig_token_enc, ig_token_expires_at, ig_snapshot, status, level, reject_reason, reapply_after, ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (ig_user_id) DO UPDATE SET ig_username=$2, ig_token_enc=$3, ig_token_expires_at=$4, ig_snapshot=$5,
         status=$6, level=$7, reject_reason=$8, reapply_after=$9, updated_at=now()
       RETURNING id`,
      [ig.igUserId, ig.username, encrypt(token), expiresAt, snapshot, result.qualified ? 'ig_connected' : 'rejected', result.level,
        result.qualified ? null : result.reasons.map((r) => r.code).join(','), result.qualified ? null : reapply, ipHash(req)],
    )).rows[0];
    await audit('system', 'creator', row.id, result.qualified ? 'instagram_qualified' : 'instagram_rejected', null, snapshot);

    if (!result.qualified) {
      return res.send(page('Not this time', `<h1>Your account does not qualify yet</h1>
<div class="card"><ul>${result.reasons.map((r) => `<li>${esc(r.message)}</li>`).join('')}</ul></div>
<p>You can apply again from ${reapply.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.</p>`));
    }
    res.cookie('signup', sign({ cid: row.id, k: 'signup' }, 60 * 60), cookieOpts);
    res.redirect('/join/details');
  } catch (e) { next(e); }
});

function detailsForm(c, errors = [], v = {}) {
  const spotlight = c.level === 'spotlight';
  const csrf = sign({ cid: c.id, k: 'csrf' }, 60 * 60);
  return page('Your details', `
<h1>Nearly there, @${esc(c.ig_username)}</h1>
<p>Your Instagram account qualifies. Add your details so we can set up your code and pay you.</p>
${errors.length ? `<div class="err">${errors.map(esc).join('<br>')}</div>` : ''}
<form method="post" action="/join/details" autocomplete="on">
<input type="hidden" name="csrf" value="${esc(csrf)}"><input class="hp" type="text" name="website" tabindex="-1" autocomplete="off">
<label>Full name</label><input type="text" name="name" required value="${esc(v.name)}">
<label>Email</label><input type="email" name="email" required value="${esc(v.email)}"><div class="hint">We send your code, statements and sign-in links here.</div>
<label>Mobile</label><input type="tel" name="mobile" required pattern="[0-9+ \\-]{10,15}" value="${esc(v.mobile)}"><div class="hint">10-digit Indian mobile number.</div>
<label>Preferred code (optional)</label><input type="text" name="preferred_code" maxlength="15" value="${esc(v.preferred_code)}"><div class="hint">4 to 15 letters or numbers. If it is taken, we make one from your handle.</div>
<h2>Payout and tax</h2><p class="hint">Needed to pay you and to deduct tax at source as the law requires. Stored encrypted; we show only the last four characters.</p>
<label>PAN</label><input type="text" name="pan" required maxlength="10" value="${esc(v.pan)}">
<label>Name exactly as on PAN</label><input type="text" name="pan_name" required value="${esc(v.pan_name)}">
<label>Payout method</label><select name="payout_method"><option value="upi" ${v.payout_method !== 'bank' ? 'selected' : ''}>UPI</option><option value="bank" ${v.payout_method === 'bank' ? 'selected' : ''}>Bank account</option></select>
<label>UPI ID (if UPI)</label><input type="text" name="vpa" value="${esc(v.vpa)}">
<label>Bank account number (if bank)</label><input type="text" name="account" value="${esc(v.account)}">
<label>IFSC (if bank)</label><input type="text" name="ifsc" value="${esc(v.ifsc)}">
${spotlight ? `<h2>Where should we send your tube</h2><p class="hint">Your reach puts you in our Spotlight group, so we send you a tube of Clockwork Daily.</p>
<label>Address line 1</label><input type="text" name="address1" required value="${esc(v.address1)}">
<label>Address line 2</label><input type="text" name="address2" value="${esc(v.address2)}">
<label>City</label><input type="text" name="city" required value="${esc(v.city)}">
<label>State</label><input type="text" name="province" required value="${esc(v.province)}">
<label>PIN code</label><input type="text" name="zip" required pattern="[0-9]{6}" value="${esc(v.zip)}">` : ''}
<label><input type="checkbox" name="terms" value="yes" required> I agree to the <a href="${esc(config.storeUrl)}/pages/creator-terms" target="_blank">Creator Terms</a></label>
<label style="font-weight:400"><input type="checkbox" name="marketing" value="yes"> Send me Clockwork product news and Lab Notes (optional)</label>
<p><button class="btn" type="submit">Continue</button></p></form>`);
}

async function signupCreator(req) {
  const t = verify(req.cookies.signup);
  if (!t || t.k !== 'signup') return null;
  const c = (await q('SELECT * FROM creators WHERE id = $1', [t.cid])).rows[0];
  return c && c.status === 'ig_connected' ? c : null;
}

join.get('/join/details', async (req, res, next) => {
  try {
    const c = await signupCreator(req);
    if (!c) return res.redirect('/');
    res.send(detailsForm(c));
  } catch (e) { next(e); }
});

join.post('/join/details', limiter, express.urlencoded({ extended: false }), async (req, res, next) => {
  try {
    const c = await signupCreator(req);
    if (!c) return res.redirect('/');
    const b = req.body;
    const csrf = verify(b.csrf);
    if (!csrf || csrf.cid !== c.id || csrf.k !== 'csrf' || b.website) return res.status(400).send(page('Error', '<h1>Please try again</h1>'));

    const errors = [];
    const email = normaliseEmail(b.email);
    const mobile = normalisePhone(b.mobile);
    const pan = String(b.pan || '').toUpperCase().trim();
    if (!b.name?.trim()) errors.push('Enter your full name.');
    if (!email) errors.push('Enter a valid email address.');
    if (!mobile) errors.push('Enter a valid 10-digit Indian mobile number.');
    if (!isValidPan(pan)) errors.push('Enter a valid PAN, for example ABCDE1234F.');
    if (!b.pan_name?.trim()) errors.push('Enter your name exactly as on your PAN.');
    let payout;
    if (b.payout_method === 'bank') {
      const account = String(b.account || '').replace(/\s/g, '');
      const ifsc = String(b.ifsc || '').toUpperCase().trim();
      if (!/^\d{9,18}$/.test(account) || !isValidIfsc(ifsc)) errors.push('Enter a valid bank account number and IFSC.');
      payout = { method: 'bank', account, ifsc, key: `${account}@${ifsc}`, last4: account.slice(-4) };
    } else {
      const vpa = String(b.vpa || '').trim().toLowerCase();
      if (!isValidVpa(vpa)) errors.push('Enter a valid UPI ID, for example name@okhdfcbank.');
      payout = { method: 'upi', vpa, key: vpa, last4: vpa.split('@')[0].slice(-4) };
    }
    if (b.terms !== 'yes') errors.push('Please agree to the Creator Terms.');
    let kitAddress = null;
    if (c.level === 'spotlight') {
      if (!b.address1 || !b.city || !b.province || !/^\d{6}$/.test(b.zip || '')) errors.push('Enter a full delivery address for your tube.');
      kitAddress = { firstName: b.name?.trim().split(' ')[0], lastName: b.name?.trim().split(' ').slice(1).join(' ') || '.', address1: b.address1, address2: b.address2 || '', city: b.city, province: b.province, zip: b.zip, phone: mobile };
    }
    if (errors.length) return res.status(400).send(detailsForm(c, errors, b));

    // Automatic decisions, no manual holds.
    const domain = email.split('@')[1];
    const emailHash = hashId(email);
    const mobileHash = hashId(mobile);
    const panHash = hashId(pan);
    const payoutHash = hashId(payout.key);
    const reject = async (reason, message) => {
      await q(`UPDATE creators SET status='rejected', reject_reason=$2, reapply_after=$3, updated_at=now() WHERE id=$1`,
        [c.id, reason, new Date(Date.now() + config.qualification.reapplyAfterDays * 86400000)]);
      await audit('system', 'creator', c.id, `rejected:${reason}`, null, null);
      res.clearCookie('signup');
      return res.send(page('Not eligible', `<h1>We cannot accept this application</h1><p>${esc(message)}</p><p class="hint">Questions: partners@clockworkrituals.com</p>`));
    };
    if (config.qualification.staffDomains.includes(domain)) return reject('staff', 'Clockwork staff cannot join the programme.');
    const suspended = await q(`SELECT 1 FROM creators WHERE status='suspended' AND (pan_hash=$1 OR payout_hash=$2)`, [panHash, payoutHash]);
    if (suspended.rowCount) return reject('linked_to_suspended', 'These details are linked to an account that was removed from the programme.');
    const dup = await q(
      `SELECT 1 FROM creators WHERE id <> $1 AND status NOT IN ('rejected') AND (email_hash=$2 OR mobile_hash=$3 OR pan_hash=$4 OR payout_hash=$5)`,
      [c.id, emailHash, mobileHash, panHash, payoutHash],
    );
    if (dup.rowCount) return reject('duplicate', 'An account with these details has already joined. Each person can join once.');
    const recent = await q(`SELECT count(*)::int AS n FROM signup_ips WHERE ip_hash=$1 AND ts > now() - interval '24 hours'`, [ipHash(req)]);
    if (recent.rows[0].n >= 3) return reject('ip_limit', 'Too many applications have come from this network today. Please try again tomorrow.');
    await q('INSERT INTO signup_ips (ip_hash) VALUES ($1)', [ipHash(req)]);

    await q(
      `UPDATE creators SET status='pending_email', name=$2, email=$3, email_hash=$4, mobile_hash=$5, mobile_last4=$6,
        preferred_code=$7, pan_enc=$8, pan_hash=$9, pan_last4=$10, pan_name=$11, payout_method=$12, payout_enc=$13,
        payout_hash=$14, payout_last4=$15, terms_version=$16, terms_accepted_at=now(), marketing_opt_in=$17,
        kit_address_enc=$18, address_hashes=$19, updated_at=now() WHERE id=$1`,
      [c.id, b.name.trim(), email, emailHash, mobileHash, mobile.slice(-4), cleanCode(b.preferred_code) || null,
        encrypt(pan), panHash, pan.slice(-4), b.pan_name.trim(), payout.method,
        encrypt(JSON.stringify(payout.method === 'bank' ? { account: payout.account, ifsc: payout.ifsc } : { vpa: payout.vpa })),
        payoutHash, payout.last4, config.termsVersion, b.marketing === 'yes',
        kitAddress ? encrypt(JSON.stringify(kitAddress)) : null, kitAddress ? [hashId(normaliseAddress(kitAddress))] : []],
    );
    const link = `${config.baseUrl}/verify?t=${sign({ cid: c.id, k: 'verify' }, 24 * 3600)}`;
    await emails.verify(email, link);
    res.clearCookie('signup');
    res.send(page('Check your email', `<h1>Check your email</h1><p>We have sent a link to <strong>${esc(email)}</strong>. Open it to confirm your address, and your code will be ready.</p>`));
  } catch (e) {
    if (e.code === '23505') return res.status(400).send(page('Already joined', '<h1>These details are already registered</h1><p><a class="btn" href="/login">Sign in</a></p>'));
    next(e);
  }
});

join.get('/verify', async (req, res, next) => {
  try {
    const t = verify(String(req.query.t || ''));
    if (!t || t.k !== 'verify') return res.status(400).send(page('Link expired', '<h1>This link has expired</h1><p>Start again to get a new one.</p><p><a class="btn" href="/">Start again</a></p>'));
    const c = await activate(t.cid);
    if (!c || c.status !== 'active') return res.redirect('/login');
    res.cookie('session', sign({ cid: c.id, k: 'session' }, 30 * 86400), { ...cookieOpts, maxAge: 30 * 86400 * 1000 });
    res.redirect('/dashboard?welcome=1');
  } catch (e) { next(e); }
});
