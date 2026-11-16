// Runs against a real Postgres (TEST_DATABASE_URL). Shopify and Instagram are faked; no network calls leave the machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
if (!url) { test('integration (skipped: set TEST_DATABASE_URL)', () => {}); }
else {
  process.env.DATABASE_URL = url;
  process.env.DATA_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.SIGNING_KEY = 'b'.repeat(64);
  process.env.HASH_PEPPER = 'c'.repeat(64);
  process.env.SHOPIFY_SHOP = 'test.myshopify.com';
  process.env.SHOPIFY_CREATOR_COLLECTION_ID = 'gid://shopify/Collection/1';
  process.env.SCHEDULER_ENABLED = 'false';
  process.env.DRY_RUN = 'true';

  const shopifyCalls = [];
  global.fetch = async (u, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : {};
    shopifyCalls.push(body.query || String(u));
    const q = body.query || '';
    const data = q.includes('codeDiscountNodeByCode') ? { codeDiscountNodeByCode: null }
      : q.includes('discountCodeBasicCreate') ? { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/99' }, userErrors: [] } }
      : {};
    return { ok: true, status: 200, json: async () => ({ data }) };
  };

  const { pool, q } = await import('../src/db.js');
  const { migrate } = await import('../src/migrate.js');
  const { processOrder } = await import('../src/services/orders.js');
  const { activate } = await import('../src/services/creators.js');
  const { payoutRun } = await import('../src/jobs/index.js');
  const { hashId, encrypt } = await import('../src/lib/crypto.js');

  before(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate();
  });
  after(async () => { await pool.end(); });

  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const mkOrder = (id, over = {}) => ({
    id: `gid://shopify/Order/${id}`, name: `#${id}`, placedAt: daysAgo(20), deliveredAt: daysAgo(10), cancelledAt: null,
    financialStatus: 'PAID', fulfilled: true, tags: [], isStaff: false, isCod: false, discountCodes: ['PRIYA'], attributes: {},
    fullyRefunded: false, emailHash: hashId(`c${id}@x.com`), phoneHash: hashId(`98${id}`), addressHash: hashId(`addr ${id}`), pincodeHash: hashId(`1100${id % 10}`),
    lineItems: [{ handle: 'peppermint-toothpaste-with-nhap', quantity: 2, currentQuantity: 2, discountedTotalPaise: 98910, taxPaise: 0, tubesPerUnit: 1 }],
    ...over,
  });

  let creatorId;
  test('sign-up → verify creates the code and the Shopify discount', async () => {
    const r = await q(`INSERT INTO creators (ig_user_id, ig_username, status, level, name, email, email_hash, mobile_hash, pan_enc, pan_hash, payout_method, preferred_code)
      VALUES ('ig1','priya.brushes','pending_email','creator','Priya','priya@example.com',$1,$2,$3,$4,'upi','priya') RETURNING id`,
    [hashId('priya@example.com'), hashId('9876543210'), encrypt('ABCDE1234F'), hashId('ABCDE1234F')]);
    creatorId = r.rows[0].id;
    const c = await activate(creatorId);
    assert.equal(c.status, 'active');
    assert.equal(c.code, 'PRIYA');
    assert.ok(shopifyCalls.some((x) => x.includes('discountCodeBasicCreate')));
  });

  test('history: an earlier order on the same phone makes a later order a repeat', async () => {
    // Customer A ordered before, without any code.
    await processOrder(mkOrder(1, { discountCodes: [], placedAt: daysAgo(200), deliveredAt: daysAgo(195) }));
    const r = await processOrder(mkOrder(2, { phoneHash: hashId('981') }));
    assert.equal(r.basis, 'percent');
  });

  test('a new customer through the code earns ₹300 once locked', async () => {
    const r = await processOrder(mkOrder(3));
    assert.equal(r.basis, 'flat');
    assert.equal(r.state, 'locked');
    assert.equal(r.commission, 30000);
  });

  test('the same customer cannot earn ₹300 twice, even via another email', async () => {
    const r = await processOrder(mkOrder(4, { emailHash: hashId('other@x.com'), phoneHash: hashId('983') }));
    assert.equal(r.basis, 'percent');
  });

  test('within the 7-day window it is qualifying; COD unconfirmed is pending', async () => {
    assert.equal((await processOrder(mkOrder(5, { deliveredAt: daysAgo(2) }))).state, 'qualifying');
    assert.equal((await processOrder(mkOrder(6, { tags: ['COD-Unconfirmed'], financialStatus: 'PENDING' }))).state, 'pending');
  });

  test('processing the same order again changes nothing', async () => {
    const r = await processOrder(mkOrder(3));
    assert.equal(r.commission, 30000);
    const n = await q('SELECT count(*)::int AS n FROM attributions WHERE order_id=$1', ['gid://shopify/Order/3']);
    assert.equal(n.rows[0].n, 1);
  });

  test('a refund after cancellation reverses and frees the ₹300 claim', async () => {
    const r = await processOrder(mkOrder(5, { fullyRefunded: true, deliveredAt: daysAgo(2) }));
    assert.equal(r.state, 'reversed');
    const id = await q(`SELECT flat_paid_order_id FROM identities WHERE kind='phone' AND hash=$1`, [hashId('985')]);
    assert.equal(id.rows[0].flat_paid_order_id, null);
  });

  test('DRY_RUN payout run calculates, moves no money, and refuses to run twice', async () => {
    const r1 = await payoutRun();
    assert.ok(r1.runId.startsWith('dry-'));
    assert.equal(r1.totals.creators, 1);
    // ₹300 for order 3 plus 10% of the GST-exclusive value of repeat orders 2 and 4.
    const pct = Math.floor((Math.floor(98910 / 1.18 + 1e-9) * 1000) / 10000);
    assert.ok(Math.abs(r1.totals.gross - (30000 + 2 * pct)) <= 2, `gross ${r1.totals.gross}`);
    const paid = await q('SELECT count(*)::int AS n FROM attributions WHERE paid_in_payout_id IS NOT NULL');
    assert.equal(paid.rows[0].n, 0);
    const r2 = await payoutRun();
    assert.equal(r2.refused, true);
  });
}
