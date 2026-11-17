// Creators see only pages on clockworkrituals.com (theme sections). This service supplies data to those pages
// and handles the two steps that must happen here: the Instagram return and the email-verification link.
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
const cookieOpts = { httpOnly: true, secure: config.env === 'production', sameSite: 'lax', maxAge: 10 * 60 * 1000 };
const ipHash = (req) => hashId(req.ip);
export const storePage = (handle, params = {}) => {
  const u = new URL(`${config.storeUrl}/pages/${handle}`);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
};
const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

join.get('/', (req, res) => res.redirect(storePage('creators')));

// Start Instagram login. Called from the "Connect Instagram" button on /pages/creators.
join.get('/join', limiter, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, cookieOpts);
  res.redirect(authorizeUrl(state));
});

// Instagram returns here; we decide and send the creator straight back to the Clockwork page.
join.get('/auth/instagram/callback', limiter, async (req, res, next) => {
  try {
    if (!req.query.state || req.query.state !== req.cookies.oauth_state) return res.redirect(storePage('creators', { result: 'expired' }));
    if (req.query.error) return res.redirect(storePage('creators', { result: 'cancelled' }));
    const { token, expiresAt } = await exchangeCode(String(req.query.code));
    const ig = await fetchAccount(token);
    const prior = (await q('SELECT * FROM creators WHERE ig_user_id = $1', [ig.igUserId])).rows[0];

    if (prior && ['active', 'paused', 'pending_email'].includes(prior.status)) return res.redirect(storePage('creator-dashboard', { result: 'already_joined' }));
    if (prior?.status === 'suspended') return res.redirect(storePage('creators', { result: 'not_eligible' }));
    if (prior?.reapply_after && new Date(prior.reapply_after) > new Date()) return res.redirect(storePage('creators', { result: 'wait', after: fmtDate(prior.reapply_after) }));

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
      return res.redirect(storePage('creators', { result: 'not_qualified', reasons: [...new Set(result.reasons.map((r) => r.code))].join(','), after: fmtDate(reapply) }));
    }
    res.redirect(storePage('creators', { step: 'details', s: sign({ cid: row.id, k: 'signup' }, 60 * 60) }));
  } catch (e) { next(e); }
});

// The email-verification link: activate, then land on the dashboard page already signed in.
join.get('/verify', async (req, res, next) => {
  try {
    const t = verify(String(req.query.t || ''));
    if (!t || t.k !== 'verify') return res.redirect(storePage('creators', { result: 'link_expired' }));
    const c = await activate(t.cid);
    if (!c || c.status !== 'active') return res.redirect(storePage('creator-dashboard'));
    res.redirect(storePage('creator-dashboard', { t: sign({ cid: c.id, k: 'login' }, 15 * 60), welcome: '1' }));
  } catch (e) { next(e); }
});

// ---------- JSON API for /pages/creators ----------

async function signupCreator(token) {
  const t = verify(token);
  if (!t || t.k !== 'signup') return null;
  const c = (await q('SELECT * FROM creators WHERE id = $1', [t.cid])).rows[0];
  return c && c.status === 'ig_connected' ? c : null;
}

join.get('/api/signup', async (req, res, next) => {
  try {
    const c = await signupCreator(String(req.query.s || ''));
    if (!c) return res.status(401).json({ error: 'expired' });
    res.json({ username: c.ig_username, spotlight: c.level === 'spotlight', termsUrl: `${config.storeUrl}/pages/creator-terms` });
  } catch (e) { next(e); }
});

join.post('/api/signup', limiter, express.json({ limit: '20kb' }), async (req, res, next) => {
  try {
    const b = req.body || {};
    const c = await signupCreator(String(b.s || ''));
    if (!c) return res.status(401).json({ error: 'expired' });
    if (b.website) return res.status(400).json({ errors: ['Please try again.'] }); // honeypot

    const errors = [];
    const name = String(b.name || '').trim();
    const email = normaliseEmail(b.email);
    const mobile = normalisePhone(b.mobile);
    const pan = String(b.pan || '').toUpperCase().trim();
    const panName = String(b.pan_name || '').trim();
    if (!name) errors.push('Enter your full name.');
    if (!email) errors.push('Enter a valid email address.');
    if (!mobile) errors.push('Enter a valid 10-digit Indian mobile number.');
    if (!isValidPan(pan)) errors.push('Enter a valid PAN, for example ABCDE1234F.');
    if (!panName) errors.push('Enter your name exactly as on your PAN.');
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
    if (b.terms !== true) errors.push('Please agree to the Creator Terms.');
    let kitAddress = null;
    if (c.level === 'spotlight') {
      if (!b.address1 || !b.city || !b.province || !/^\d{6}$/.test(String(b.zip || ''))) errors.push('Enter a full delivery address for your tube.');
      kitAddress = { firstName: name.split(' ')[0], lastName: name.split(' ').slice(1).join(' ') || '.', address1: String(b.address1 || ''), address2: String(b.address2 || ''), city: String(b.city || ''), province: String(b.province || ''), zip: String(b.zip || ''), phone: mobile };
    }
    if (errors.length) return res.status(400).json({ errors });

    const reject = async (reason, message) => {
      await q(`UPDATE creators SET status='rejected', reject_reason=$2, reapply_after=$3, updated_at=now() WHERE id=$1`,
        [c.id, reason, new Date(Date.now() + config.qualification.reapplyAfterDays * 86400000)]);
      await audit('system', 'creator', c.id, `rejected:${reason}`, null, null);
      return res.status(403).json({ rejected: true, message });
    };
    const emailHash = hashId(email);
    const mobileHash = hashId(mobile);
    const panHash = hashId(pan);
    const payoutHash = hashId(payout.key);
    if (config.qualification.staffDomains.includes(email.split('@')[1])) return reject('staff', 'Clockwork staff cannot join the programme.');
    const suspended = await q(`SELECT 1 FROM creators WHERE status='suspended' AND (pan_hash=$1 OR payout_hash=$2)`, [panHash, payoutHash]);
    if (suspended.rowCount) return reject('linked_to_suspended', 'These details are linked to an account that was removed from the programme.');
    const dup = await q(`SELECT 1 FROM creators WHERE id <> $1 AND status NOT IN ('rejected') AND (email_hash=$2 OR mobile_hash=$3 OR pan_hash=$4 OR payout_hash=$5)`,
      [c.id, emailHash, mobileHash, panHash, payoutHash]);
    if (dup.rowCount) return reject('duplicate', 'An account with these details has already joined. Each person can join once.');
    const recent = await q(`SELECT count(*)::int AS n FROM signup_ips WHERE ip_hash=$1 AND ts > now() - interval '24 hours'`, [ipHash(req)]);
    if (recent.rows[0].n >= 3) return reject('ip_limit', 'Too many applications have come from this network today. Please try again tomorrow.');
    await q('INSERT INTO signup_ips (ip_hash) VALUES ($1)', [ipHash(req)]);

    await q(
      `UPDATE creators SET status='pending_email', name=$2, email=$3, email_hash=$4, mobile_hash=$5, mobile_last4=$6,
        preferred_code=$7, pan_enc=$8, pan_hash=$9, pan_last4=$10, pan_name=$11, payout_method=$12, payout_enc=$13,
        payout_hash=$14, payout_last4=$15, terms_version=$16, terms_accepted_at=now(), marketing_opt_in=$17,
        kit_address_enc=$18, address_hashes=$19, updated_at=now() WHERE id=$1`,
      [c.id, name, email, emailHash, mobileHash, mobile.slice(-4), cleanCode(b.preferred_code) || null,
        encrypt(pan), panHash, pan.slice(-4), panName, payout.method,
        encrypt(JSON.stringify(payout.method === 'bank' ? { account: payout.account, ifsc: payout.ifsc } : { vpa: payout.vpa })),
        payoutHash, payout.last4, config.termsVersion, b.marketing === true,
        kitAddress ? encrypt(JSON.stringify(kitAddress)) : null, kitAddress ? [hashId(normaliseAddress(kitAddress))] : []],
    );
    await emails.verify(email, `${config.baseUrl}/verify?t=${sign({ cid: c.id, k: 'verify' }, 24 * 3600)}`);
    res.json({ ok: true, email });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ errors: ['These details are already registered. Sign in to your dashboard instead.'] });
    next(e);
  }
});

// Fallback page for anyone who opens the service address directly.
join.get('/status', (req, res) => res.send(page('Clockwork Creators', `<h1>Clockwork Creators</h1><p><a class="btn" href="${esc(storePage('creators'))}">Go to Clockwork Creators</a></p>`)));
