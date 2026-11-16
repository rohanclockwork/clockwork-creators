import crypto from 'node:crypto';
import { config } from '../config.js';

const key = (hex, name) => {
  if (!hex || hex.length !== 64) throw new Error(`${name} must be 32 bytes, hex encoded (64 characters)`);
  return Buffer.from(hex, 'hex');
};

// AES-256-GCM for PAN, payout details and Instagram tokens at rest.
export function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(config.secrets.dataKey, 'DATA_ENCRYPTION_KEY'), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(blob) {
  if (!blob) return null;
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(config.secrets.dataKey, 'DATA_ENCRYPTION_KEY'), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// One-way keyed hash, so identities can be matched without storing them in the clear.
export function hashId(value) {
  if (!value) return null;
  return crypto.createHmac('sha256', key(config.secrets.hashPepper, 'HASH_PEPPER')).update(String(value)).digest('hex');
}

export function normaliseEmail(e) {
  if (!e) return null;
  const s = String(e).trim().toLowerCase();
  const [local, domain] = s.split('@');
  if (!domain) return null;
  const l = ['gmail.com', 'googlemail.com'].includes(domain) ? local.split('+')[0].replace(/\./g, '') : local.split('+')[0];
  return `${l}@${domain === 'googlemail.com' ? 'gmail.com' : domain}`;
}

export function normalisePhone(p) {
  if (!p) return null;
  const d = String(p).replace(/\D/g, '');
  const ten = d.length > 10 ? d.slice(-10) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

export function normaliseAddress(a) {
  if (!a) return null;
  const line = [a.address1, a.address2, a.zip].filter(Boolean).join(' ').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\b(flat|house|h|no|number|apt|apartment|floor|road|rd|street|st|sector|sec|near|opp|opposite)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return line || null;
}

// Signed, expiring tokens for magic links, email verification and sessions.
export function sign(payload, ttlSeconds) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const mac = crypto.createHmac('sha256', key(config.secrets.signingKey, 'SIGNING_KEY')).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', key(config.secrets.signingKey, 'SIGNING_KEY')).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (data.exp < Math.floor(Date.now() / 1000)) return null;
  return data;
}

export function shopifyHmacValid(rawBody, headerHmac, secret) {
  if (!headerHmac || !secret) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(headerHmac);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
