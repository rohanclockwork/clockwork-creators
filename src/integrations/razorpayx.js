// RazorpayX: contacts, fund accounts, payouts and webhook signatures.
// Payout requests need the server's IPs allow-listed in RazorpayX and an idempotency key (X-Payout-Idempotency).
import crypto from 'node:crypto';

const cfg = () => ({
  keyId: process.env.RAZORPAYX_KEY_ID || '',
  keySecret: process.env.RAZORPAYX_KEY_SECRET || '',
  accountNumber: process.env.RAZORPAYX_ACCOUNT_NUMBER || '',
  webhookSecret: process.env.RAZORPAYX_WEBHOOK_SECRET || '',
  // Account validation is unavailable in test mode and only on RazorpayX Lite; switch on only if your account supports it.
  validate: String(process.env.RAZORPAYX_VALIDATE_ACCOUNTS || 'false') === 'true',
  base: process.env.RAZORPAYX_API_BASE || 'https://api.razorpay.com/v1',
});

export const configured = () => Boolean(cfg().keyId && cfg().keySecret && cfg().accountNumber);
export const isTestMode = () => cfg().keyId.startsWith('rzp_test_');
export const validationEnabled = () => cfg().validate;

async function call(method, path, body, headers = {}) {
  const c = cfg();
  const res = await fetch(`${c.base}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${c.keyId}:${c.keySecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`RazorpayX ${method} ${path}: ${res.status} ${json?.error?.description || JSON.stringify(json)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export async function createContact({ name, email, mobile, creatorId }) {
  return call('POST', '/contacts', {
    name: name.slice(0, 50), email, contact: mobile, type: 'vendor',
    reference_id: `creator-${creatorId}`, notes: { programme: 'Clockwork Creators' },
  });
}

export async function createFundAccount({ contactId, method, vpa, account, ifsc, holderName }) {
  const body = method === 'bank'
    ? { contact_id: contactId, account_type: 'bank_account', bank_account: { name: holderName.slice(0, 120), ifsc, account_number: account } }
    : { contact_id: contactId, account_type: 'vpa', vpa: { address: vpa } };
  return call('POST', '/fund_accounts', body);
}

/** Only where the account supports it. Returns { ok, registeredName, status }. */
export async function validateFundAccount({ fundAccountId, creatorId }) {
  const v = await call('POST', '/fund_accounts/validations', {
    account_number: cfg().accountNumber, fund_account: { id: fundAccountId }, amount: 100, currency: 'INR',
    notes: { creator: String(creatorId) },
  });
  const r = v.results || {};
  return { ok: (r.account_status || '').toLowerCase() === 'active', registeredName: r.registered_name || null, status: v.status };
}

// RazorpayX narration: up to 30 characters, letters, numbers and spaces only.
export const narration = (label) => `Clockwork creator ${label}`.replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);

export function payoutMode(method, amountPaise) {
  if (method === 'upi') return 'UPI';
  return amountPaise <= 500000 * 100 ? 'IMPS' : 'NEFT'; // IMPS up to ₹5 lakh
}

export async function createPayout({ fundAccountId, amountPaise, method, referenceId, label }) {
  return call('POST', '/payouts', {
    account_number: cfg().accountNumber,
    fund_account_id: fundAccountId,
    amount: amountPaise,
    currency: 'INR',
    mode: payoutMode(method, amountPaise),
    purpose: 'payout',
    queue_if_low_balance: true,
    reference_id: referenceId,
    narration: narration(label),
    notes: { programme: 'Clockwork Creators', reference: referenceId },
  }, { 'X-Payout-Idempotency': referenceId });
}

export function webhookValid(rawBody, signature) {
  const secret = cfg().webhookSecret;
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Loose name match for validation results: share of the PAN name's words found in the bank's registered name. */
export function nameMatch(panName, registeredName) {
  const words = (s) => String(s || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  const a = words(panName);
  const b = new Set(words(registeredName));
  if (!a.length || !b.size) return 0;
  return a.filter((w) => b.has(w) || [...b].some((x) => x[0] === w[0] && (x.length === 1 || w.length === 1))).length / a.length;
}
