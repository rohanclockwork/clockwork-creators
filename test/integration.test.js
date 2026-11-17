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
  const rzpCalls = [];
  global.fetch = async (u, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : {};
    if (String(u).includes('api.razorpay.com')) {
      rzpCalls.push({ url: String(u), body, headers: opts.headers });
      const path = String(u).split('/v1')[1];
      const out = path === '/contacts' ? { id: 'cont_1' } : path === '/fund_accounts' ? { id: 'fa_1' }
        : path === '/payouts' ? { id: `pout_${rzpCalls.length}`, status: 'processing', utr: null } : {};
      return { ok: true, status: 200, json: async () => out };
    }
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
  const { config } = await import('../src/config.js');
  const { handlePayoutEvent } = await import('../src/services/payouts.js');

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
    await q('UPDATE creators SET payout_enc=$2, pan_name=$3 WHERE id=$1', [r.rows[0].id, encrypt(JSON.stringify({ vpa: 'priya@okhdfcbank' })), 'Priya Rao']);
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

  test('RazorpayX test mode: pays once with the reference as idempotency key, then refuses a second run', async () => {
    process.env.RAZORPAYX_KEY_ID = 'rzp_test_abc';
    process.env.RAZORPAYX_KEY_SECRET = 'x';
    process.env.RAZORPAYX_ACCOUNT_NUMBER = '7878780080316316';
    process.env.RAZORPAYX_WEBHOOK_SECRET = 'whk';
    config.dryRun = false;
    config.payouts.minPayoutPaise = 10000; // the test balance is ₹467, under the real ₹500 minimum
    await q('UPDATE creators SET rzp_fund_account_id=NULL');
    const r1 = await payoutRun();
    assert.ok(r1.runId.startsWith('test-'), r1.runId);
    assert.ok(rzpCalls.some((c) => c.url.endsWith('/contacts')) && rzpCalls.some((c) => c.url.endsWith('/fund_accounts')), 'contact and fund account created on the fly');
    const pay = rzpCalls.find((c) => c.url.endsWith('/payouts'));
    assert.ok(pay, 'a payout was requested');
    assert.equal(pay.body.mode, 'UPI');
    assert.equal(pay.body.purpose, 'payout');
    assert.equal(pay.headers['X-Payout-Idempotency'], pay.body.reference_id);
    assert.ok(pay.body.narration.length <= 30);
    const row = (await q(`SELECT * FROM payouts WHERE run_id=$1`, [r1.runId])).rows[0];
    assert.equal(row.net_paise, pay.body.amount);
    const marked = await q('SELECT count(*)::int AS n FROM attributions WHERE paid_in_payout_id=$1', [row.id]);
    assert.ok(marked.rows[0].n >= 1);
    const r2 = await payoutRun();
    assert.equal(r2.refused, true);
    assert.equal(rzpCalls.filter((c) => c.url.endsWith('/payouts')).length, 1);
  });

  test('payout webhooks: processed stores the UTR; a returned payout goes back on the balance and holds payouts', async () => {
    const row = (await q(`SELECT * FROM payouts WHERE run_id LIKE 'test-%'`)).rows[0];
    await handlePayoutEvent({ event: 'payout.processed', payload: { payout: { entity: { id: 'pout_x', reference_id: row.reference_id, utr: 'UTR123' } } } });
    assert.equal((await q('SELECT utr, status FROM payouts WHERE id=$1', [row.id])).rows[0].utr, 'UTR123');
    await handlePayoutEvent({ event: 'payout.reversed', payload: { payout: { entity: { id: 'pout_x', reference_id: row.reference_id, status_details: { description: 'Beneficiary account closed' } } } } });
    const adj = (await q(`SELECT amount_paise FROM adjustments WHERE reason LIKE 'Payout%returned%'`)).rows[0];
    assert.equal(adj.amount_paise, row.net_paise);
    const c = (await q('SELECT payout_hold_until FROM creators WHERE id=$1', [row.creator_id])).rows[0];
    assert.ok(new Date(c.payout_hold_until) > new Date(Date.now() + 300 * 86400000));
    // A replayed webhook doesn't add the money twice.
    await handlePayoutEvent({ event: 'payout.reversed', payload: { payout: { entity: { id: 'pout_x', reference_id: row.reference_id } } } });
    assert.equal((await q(`SELECT count(*)::int AS n FROM adjustments WHERE reason LIKE 'Payout%returned%'`)).rows[0].n, 1);
    config.dryRun = true;
    config.payouts.minPayoutPaise = 50000;
  });

  test('under the ₹500 minimum, the balance carries forward and nothing is sent', async () => {
    config.dryRun = false;
    await q(`UPDATE creators SET payout_hold_until=NULL`);
    await q(`INSERT INTO attributions (order_id, order_name, creator_id, code, placed_at, delivered_at, is_new_customer, base_paise, basis, commission_paise, state)
             VALUES ('gid://shopify/Order/900','#900',1,'PRIYA', now() - interval '20 days', now() - interval '10 days', false, 10000, 'percent', 1000, 'locked')`);
    const before = rzpCalls.filter((c) => c.url.endsWith('/payouts')).length;
    const r = await payoutRun(new Date(Date.now() + 8 * 86400000)); // next week's run
    const row = (await q('SELECT * FROM payouts WHERE run_id=$1', [r.runId])).rows[0];
    assert.equal(row.status, 'carried');
    assert.ok(row.carry_out_paise > 0);
    assert.equal(rzpCalls.filter((c) => c.url.endsWith('/payouts')).length, before);
    config.dryRun = true;
  });
}
