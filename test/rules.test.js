import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SIGNING_KEY = 'b'.repeat(64);
process.env.HASH_PEPPER = 'c'.repeat(64);

const { config } = await import('../src/config.js');
const { qualify } = await import('../src/lib/qualify.js');
const { evaluateOrder, commissionBasePaise } = await import('../src/lib/commission.js');
const { nextTier, repeatCheck, tdsFor, fraudSignals, financialYear, isValidPan } = await import('../src/lib/rules.js');
const { encrypt, decrypt, sign, verify, normaliseEmail, normalisePhone } = await import('../src/lib/crypto.js');

const now = new Date('2026-12-20T10:00:00Z');
const daysAgo = (n) => new Date(now.getTime() - n * 86400000).toISOString();

const goodIg = {
  username: 'priya.brushes', biography: 'slow mornings, skincare, Pune',
  followers: 8000,
  reels: Array.from({ length: 15 }, (_, i) => ({ views: 2500 + i * 10, timestamp: daysAgo(i * 2 + 1) })),
  countryCounts: { IN: 900, US: 100 },
  followerSeries: Array.from({ length: 30 }, (_, i) => 7800 + i * 7),
};

test('qualifies a real creator', () => {
  const r = qualify(goodIg, config.qualification, now);
  assert.equal(r.qualified, true, JSON.stringify(r.reasons));
  assert.equal(r.level, 'creator');
});

test('rejects below 3,000 followers', () => {
  const r = qualify({ ...goodIg, followers: 2500 }, config.qualification, now);
  assert.equal(r.qualified, false);
  assert.ok(r.reasons.some((x) => x.code === 'followers'));
});

test('rejects bought followers: big count, tiny reach', () => {
  const r = qualify({ ...goodIg, followers: 200000 }, config.qualification, now);
  assert.ok(r.reasons.some((x) => x.code === 'reach'));
});

test('rejects mostly foreign audience', () => {
  const r = qualify({ ...goodIg, countryCounts: { IN: 300, BR: 700 } }, config.qualification, now);
  assert.ok(r.reasons.some((x) => x.code === 'india_audience'));
});

test('rejects a follower spike', () => {
  const series = Array.from({ length: 30 }, (_, i) => (i < 20 ? 5000 : 8000));
  const r = qualify({ ...goodIg, followerSeries: series }, config.qualification, now);
  assert.ok(r.reasons.some((x) => x.code === 'follower_spike'));
});

test('rejects coupon accounts', () => {
  const r = qualify({ ...goodIg, username: 'best_deals_india' }, config.qualification, now);
  assert.ok(r.reasons.some((x) => x.code === 'deals_account'));
});

test('spotlight on median views of 50,000', () => {
  const reels = goodIg.reels.map((r) => ({ ...r, views: 60000 }));
  const r = qualify({ ...goodIg, followers: 200000, reels }, config.qualification, now);
  assert.equal(r.level, 'spotlight');
});

// Orders
const cfg = { ...config.commission, excludedHandles: config.shopify.excludedHandles };
const order = (over = {}) => ({
  id: 'gid://shopify/Order/1', name: '#1001', placedAt: daysAgo(20), deliveredAt: daysAgo(10),
  cancelledAt: null, fullyRefunded: false, financialStatus: 'PAID', fulfilled: true, tags: [], isStaff: false,
  emailHash: 'e1', phoneHash: 'p1', addressHash: 'a1',
  lineItems: [{ handle: 'peppermint-toothpaste-with-nhap', quantity: 2, currentQuantity: 2, discountedTotalPaise: 98910, taxPaise: 15088, tubesPerUnit: 1 }],
  ...over,
});
const creator = { id: 1, tier: 'starter', flat_rate_ended_at: null, email_hash: 'ce', phone_hash: 'cp', address_hashes: ['ca'] };

test('commission base excludes GST and the dentist kit', () => {
  const o = order({ lineItems: [
    { handle: 'peppermint-toothpaste-with-nhap', quantity: 1, currentQuantity: 1, discountedTotalPaise: 53910, taxPaise: 0 },
    { handle: 'dentist-partner-kit', quantity: 1, currentQuantity: 1, discountedTotalPaise: 19900, taxPaise: 0 },
  ] });
  assert.equal(commissionBasePaise(o, cfg.excludedHandles, 0.18), Math.floor(53910 - (53910 - 53910 / 1.18)));
});

test('new customer earns ₹300 flat once locked', () => {
  const r = evaluateOrder({ order: order(), creator, isNewCustomer: true, identityAlreadyPaidFlat: false, dentistReferral: false, cfg, now });
  assert.equal(r.state, 'locked');
  assert.equal(r.basis, 'flat');
  assert.equal(r.commission, 30000);
});

test('repeat customer earns tier percentage', () => {
  const r = evaluateOrder({ order: order(), creator, isNewCustomer: false, identityAlreadyPaidFlat: false, dentistReferral: false, cfg, now });
  assert.equal(r.basis, 'percent');
  assert.equal(r.commission, Math.floor(((98910 - 15088) * 1000) / 10000));
});

test('identity that already earned ₹300 falls back to percentage', () => {
  const r = evaluateOrder({ order: order(), creator, isNewCustomer: true, identityAlreadyPaidFlat: true, dentistReferral: false, cfg, now });
  assert.equal(r.basis, 'percent');
});

test('orders after 30 June 2027 do not earn ₹300', () => {
  const late = new Date('2027-07-20T10:00:00Z');
  const o = order({ placedAt: '2027-07-01T04:00:00Z', deliveredAt: '2027-07-05T04:00:00Z' });
  const r = evaluateOrder({ order: o, creator, isNewCustomer: true, identityAlreadyPaidFlat: false, dentistReferral: false, cfg, now: late });
  assert.equal(r.basis, 'percent');
});

test('within 7 days of delivery is qualifying, not locked', () => {
  const r = evaluateOrder({ order: order({ deliveredAt: daysAgo(3) }), creator, isNewCustomer: true, identityAlreadyPaidFlat: false, dentistReferral: false, cfg, now });
  assert.equal(r.state, 'qualifying');
});

test('COD unconfirmed never qualifies; confirmed and delivered does', () => {
  const a = evaluateOrder({ order: order({ financialStatus: 'PENDING', tags: ['COD-Unconfirmed'] }), creator, isNewCustomer: true, identityAlreadyPaidFlat: false, dentistReferral: false, cfg, now });
  assert.equal(a.state, 'pending');
  const b = evaluateOrder({ order: order({ financialStatus: 'PENDING', tags: ['Order Confirmed'] }), creator, isNewCustomer: true, identityAlreadyPaidFlat: false, dentistReferral: false, cfg, now });
  assert.equal(b.state, 'locked');
});

test('self-purchase earns nothing', () => {
  const r = evaluateOrder({ order: order({ phoneHash: 'cp' }), creator, isNewCustomer: true, identityAlreadyPaidFlat: false, dentistReferral: false, cfg, now });
  assert.equal(r.state, 'rejected');
  assert.equal(r.reason, 'self_purchase');
});

test('dentist referral wins', () => {
  const r = evaluateOrder({ order: order(), creator, isNewCustomer: true, identityAlreadyPaidFlat: false, dentistReferral: true, cfg, now });
  assert.equal(r.reason, 'dentist_referral');
});

test('refunded order reverses', () => {
  const r = evaluateOrder({ order: order({ fullyRefunded: true }), creator, isNewCustomer: true, identityAlreadyPaidFlat: false, dentistReferral: false, cfg, now });
  assert.equal(r.state, 'reversed');
});

// Tiers
const tiers = config.commission.tiers;
test('25 orders lifts Starter to Pro; grace then drop', () => {
  assert.equal(nextTier({ current: 'starter', lastMonthOrders: 25, tiers, monthStart: '2027-01-01' }).tier, 'pro');
  const g = nextTier({ current: 'pro', lastMonthOrders: 5, tiers, monthStart: '2027-02-01' });
  assert.equal(g.tier, 'pro');
  assert.equal(g.graceUntil, '2027-03-01');
  const d = nextTier({ current: 'pro', graceUntil: g.graceUntil, lastMonthOrders: 5, tiers, monthStart: '2027-03-01' });
  assert.equal(d.tier, 'starter');
});

// Repeat
test('repeat check waits for 20 due customers, then applies 30%', () => {
  const since = '2026-09-01';
  const due = (reordered) => ({ delivered_at: daysAgo(100), tubes: 1, reordered });
  assert.equal(repeatCheck({ firstOrders: Array(10).fill(due(false)), creatorSince: since, cfg: config.repeat, now }).applies, false);
  const fail = repeatCheck({ firstOrders: [...Array(5).fill(due(true)), ...Array(20).fill(due(false))], creatorSince: since, cfg: config.repeat, now });
  assert.equal(fail.pass, false);
  const pass = repeatCheck({ firstOrders: [...Array(8).fill(due(true)), ...Array(17).fill(due(false))], creatorSince: since, cfg: config.repeat, now });
  assert.equal(pass.pass, true);
});

test('2-tube orders are not due until 130 days', () => {
  const r = repeatCheck({ firstOrders: Array(25).fill({ delivered_at: daysAgo(100), tubes: 2, reordered: false }), creatorSince: '2026-01-01', cfg: config.repeat, now });
  assert.equal(r.applies, false);
});

// TDS
test('no TDS under ₹20,000; whole-year TDS once crossed', () => {
  assert.equal(tdsFor({ creditedBeforePaise: 1500000, tdsBeforePaise: 0, grossNowPaise: 300000, hasValidPan: true, cfg: config.tds }), 0);
  assert.equal(tdsFor({ creditedBeforePaise: 1800000, tdsBeforePaise: 0, grossNowPaise: 300000, hasValidPan: true, cfg: config.tds }), 42000);
  assert.equal(tdsFor({ creditedBeforePaise: 2100000, tdsBeforePaise: 42000, grossNowPaise: 100000, hasValidPan: true, cfg: config.tds }), 2000);
});

test('fraud: velocity spike without a post', () => {
  const recent = Array(30).fill({ placed_at: daysAgo(10), pincode_hash: null, is_cod: false });
  const s = fraudSignals({ recent, last24h: Array(8).fill({}), postedRecently: false, cfg: config.fraud });
  assert.ok(s.some((x) => x.code === 'velocity'));
  assert.equal(fraudSignals({ recent, last24h: Array(8).fill({}), postedRecently: true, cfg: config.fraud }).length, 0);
});

test('helpers', () => {
  assert.equal(financialYear(new Date('2027-03-31T12:00:00Z')), '2026-27');
  assert.equal(financialYear(new Date('2027-04-01T00:00:00Z')), '2027-28');
  assert.equal(isValidPan('ABCDE1234F'), true);
  assert.equal(normaliseEmail('Pri.Ya+cw@GMAIL.com'), 'priya@gmail.com');
  assert.equal(normalisePhone('+91 98765-43210'), '9876543210');
  assert.equal(decrypt(encrypt('ABCDE1234F')), 'ABCDE1234F');
  assert.equal(verify(sign({ c: 1 }, 60)).c, 1);
  assert.equal(verify(sign({ c: 1 }, -1)), null);
});
