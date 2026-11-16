import { config } from '../config.js';
import { q, tx, audit } from '../db.js';
import { evaluateOrder, tubesIn, clawbackPaise } from '../lib/commission.js';

const DENTIST_MARKERS = (process.env.DENTIST_REFERRAL_MARKERS || 'goaffpro,dentist-referral')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function hasDentistReferral(order) {
  const tags = order.tags.map((t) => t.toLowerCase());
  const attrs = Object.keys(order.attributes || {}).map((k) => k.toLowerCase());
  return DENTIST_MARKERS.some((m) => tags.some((t) => t.includes(m)) || attrs.some((a) => a.includes(m)));
}

/**
 * Record the order's identities. Returns whether this order is the customer's first ever
 * on every identity it carries, and whether any identity already earned a ₹300 payment.
 */
async function recordIdentities(client, order) {
  const ids = [['email', order.emailHash], ['phone', order.phoneHash], ['address', order.addressHash]].filter(([, h]) => h);
  if (!ids.length) return { isNew: false, alreadyPaidFlat: false };
  let isNew = true;
  let alreadyPaidFlat = false;
  for (const [kind, hash] of ids) {
    const r = await client.query(
      `INSERT INTO identities (kind, hash, first_order_id, first_seen_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (kind, hash) DO UPDATE SET
         first_order_id = CASE WHEN identities.first_seen_at > EXCLUDED.first_seen_at THEN EXCLUDED.first_order_id ELSE identities.first_order_id END,
         first_seen_at  = LEAST(identities.first_seen_at, EXCLUDED.first_seen_at)
       RETURNING first_order_id, flat_paid_order_id`,
      [kind, hash, order.id, order.placedAt],
    );
    const row = r.rows[0];
    if (row.first_order_id !== order.id) isNew = false;
    if (row.flat_paid_order_id && row.flat_paid_order_id !== order.id) alreadyPaidFlat = true;
  }
  return { isNew, alreadyPaidFlat };
}

async function setFlatClaim(client, order, claim) {
  for (const [kind, hash] of [['email', order.emailHash], ['phone', order.phoneHash], ['address', order.addressHash]]) {
    if (!hash) continue;
    if (claim) {
      await client.query('UPDATE identities SET flat_paid_order_id = $3 WHERE kind=$1 AND hash=$2 AND flat_paid_order_id IS NULL', [kind, hash, order.id]);
    } else {
      await client.query('UPDATE identities SET flat_paid_order_id = NULL WHERE kind=$1 AND hash=$2 AND flat_paid_order_id = $3', [kind, hash, order.id]);
    }
  }
}

/** Process one normalised Shopify order. Safe to call any number of times. */
export async function processOrder(order, now = new Date()) {
  return tx(async (client) => {
    const ident = await recordIdentities(client, order);
    await client.query(
      `INSERT INTO customer_orders (order_id, email_hash, phone_hash, placed_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (order_id) DO NOTHING`,
      [order.id, order.emailHash, order.phoneHash, order.placedAt],
    );

    const existing = (await client.query('SELECT * FROM attributions WHERE order_id = $1 FOR UPDATE', [order.id])).rows[0];

    let creator = null;
    if (existing) {
      creator = (await client.query('SELECT * FROM creators WHERE id = $1', [existing.creator_id])).rows[0];
    } else if (order.discountCodes.length) {
      const r = await client.query(`SELECT * FROM creators WHERE code = ANY($1) AND status IN ('active','paused')`, [order.discountCodes]);
      creator = r.rows[0] || null; // codes can't combine, so at most one creator code per order
    }
    if (!creator) return { attributed: false };

    const creatorView = {
      ...creator,
      email_hash: creator.email_hash,
      phone_hash: creator.mobile_hash,
      address_hashes: creator.address_hashes,
    };
    const isNewCustomer = existing ? existing.is_new_customer : ident.isNew;
    const r = evaluateOrder({
      order, creator: creatorView, isNewCustomer, identityAlreadyPaidFlat: ident.alreadyPaidFlat,
      dentistReferral: hasDentistReferral(order),
      cfg: { ...config.commission, excludedHandles: config.shopify.excludedHandles }, now,
    });

    // Once locked, the basis and amount don't change, except a later refund, which becomes an adjustment.
    let commission = r.commission;
    let basis = r.basis;
    let rate = r.rateBps;
    if (existing && existing.state === 'locked' && ['locked', 'qualifying'].includes(r.state)) {
      commission = existing.commission_paise; basis = existing.basis; rate = existing.rate_bps;
    }
    let state = r.state;
    if (existing?.state === 'held' && r.state === 'locked' && existing.hold_until && new Date(existing.hold_until) > now) state = 'held';

    if (existing?.paid_in_payout_id && ['reversed', 'rejected'].includes(state)) {
      const claw = clawbackPaise(existing.commission_paise, 0);
      if (claw) {
        await client.query('INSERT INTO adjustments (creator_id, order_id, amount_paise, reason) VALUES ($1,$2,$3,$4)',
          [creator.id, order.id, claw, `Order ${order.name} ${r.reason} after payment`]);
      }
    }

    await client.query(
      `INSERT INTO attributions (order_id, order_name, creator_id, code, placed_at, delivered_at, is_new_customer, tubes,
         pincode_hash, is_cod, base_paise, basis, rate_bps, commission_paise, state, reason, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
       ON CONFLICT (order_id) DO UPDATE SET delivered_at=$6, base_paise=$11, basis=$12, rate_bps=$13,
         commission_paise=$14, state=$15, reason=$16, is_cod=$10, last_synced_at=now()`,
      [order.id, order.name, creator.id, creator.code, order.placedAt, order.deliveredAt, isNewCustomer,
        tubesIn(order, config.shopify.excludedHandles), order.pincodeHash, order.isCod, r.base, basis, rate, commission, state, r.reason],
    );

    if (basis === 'flat' && !['reversed', 'rejected'].includes(state)) await setFlatClaim(client, order, true);
    if (['reversed', 'rejected'].includes(state)) await setFlatClaim(client, order, false);

    if (!existing || existing.state !== state) {
      await audit('system', 'attribution', order.id, `state:${state}`, existing ? { state: existing.state } : null, { state, basis, commission }, client);
    }
    return { attributed: true, creatorId: creator.id, state, basis, commission };
  });
}
