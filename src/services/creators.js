import { config } from '../config.js';
import { q, tx, audit } from '../db.js';
import { codeTaken, createCreatorDiscount, creatorLinks, gql } from '../integrations/shopify.js';
import { emails } from '../integrations/email.js';
import { sign, decrypt } from '../lib/crypto.js';
import { setupFundAccount } from './payouts.js';

const PROFANITY = ['fuck', 'shit', 'bitch', 'chut', 'gand', 'lund', 'bsdk', 'madar', 'behen', 'randi', 'sex', 'porn'];

export function cleanCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15);
}

export function codeAllowed(code) {
  if (code.length < 4 || code.length > 15) return false;
  if (config.qualification.reservedCodePrefixes.some((p) => code.startsWith(p))) return false;
  if (PROFANITY.some((w) => code.toLowerCase().includes(w))) return false;
  return true;
}

async function available(code) {
  if (!codeAllowed(code)) return false;
  const local = await q('SELECT 1 FROM creators WHERE code = $1', [code]);
  if (local.rowCount) return false;
  return !(await codeTaken(code));
}

/** Creator's preferred code if free and clean, else one derived from the Instagram handle. */
export async function chooseCode(preferred, handle) {
  const p = cleanCode(preferred);
  if (p && (await available(p))) return p;
  let base = cleanCode(handle);
  if (base.length < 4) base = (base + 'CREATE').slice(0, 6);
  base = base.slice(0, 12);
  if (await available(base)) return base;
  for (let i = 2; i < 100; i++) {
    const c = `${base}${i}`.slice(0, 15);
    if (await available(c)) return c;
  }
  throw new Error('Could not find a free code');
}

/** Ship the Spotlight tube as a ₹0 draft order, completed, so the warehouse ships it like any other order. */
async function createKitOrder(creator) {
  const addr = JSON.parse(decrypt(creator.kit_address_enc));
  const variantId = process.env.KIT_VARIANT_ID;
  if (!variantId) return null;
  const d = await gql(
    `mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id } userErrors { field message } } }`,
    {
      input: {
        email: creator.email,
        note: `Clockwork Creators Spotlight tube for ${creator.code}`,
        tags: ['creator-kit', `creator-${creator.code}`],
        lineItems: [{ variantId, quantity: 1 }],
        appliedDiscount: { value: 100, valueType: 'PERCENTAGE', title: 'Creator Spotlight' },
        shippingAddress: { ...addr, countryCode: 'IN' },
      },
    },
  );
  const draftId = d.draftOrderCreate.draftOrder?.id;
  if (!draftId) throw new Error(JSON.stringify(d.draftOrderCreate.userErrors));
  const c = await gql(
    `mutation($id: ID!) { draftOrderComplete(id: $id) { draftOrder { order { id name } } userErrors { field message } } }`,
    { id: draftId },
  );
  return c.draftOrderComplete.draftOrder?.order?.name || draftId;
}

/** Email verified: create the code and discount, ship the Spotlight tube, send the welcome. */
export async function activate(creatorId) {
  const c = (await q('SELECT * FROM creators WHERE id = $1', [creatorId])).rows[0];
  if (!c || c.status !== 'pending_email') return c;
  const code = await chooseCode(c.preferred_code, c.ig_username);
  const discountId = await createCreatorDiscount({ code, creatorId: c.id });
  const updated = (await q(
    `UPDATE creators SET status='active', code=$2, shopify_discount_id=$3, email_verified_at=now(), active_since=now(),
       tier_since=current_date, updated_at=now() WHERE id=$1 RETURNING *`,
    [c.id, code, discountId],
  )).rows[0];
  await audit('system', 'creator', c.id, 'activated', { status: c.status }, { status: 'active', code });

  try {
    const fa = await setupFundAccount(updated);
    if (!fa.ok) {
      await q(`UPDATE creators SET payout_hold_until = now() + interval '3650 days', payments_held_reason=$2 WHERE id=$1`, [c.id, fa.reason]);
    }
  } catch (e) {
    await emails.ownerDigest('Creator payout account not set up', `<p>Creator ${code}: ${e.message}. Their earnings carry forward until this is fixed; the next payout run retries.</p>`);
  }

  if (updated.level === 'spotlight' && updated.kit_address_enc && !updated.kit_order_id) {
    try {
      const kit = await createKitOrder(updated);
      if (kit) await q('UPDATE creators SET kit_order_id=$2 WHERE id=$1', [c.id, kit]);
    } catch (e) {
      await emails.ownerDigest('Spotlight tube not created', `<p>Creator ${code}: ${e.message}</p>`);
    }
  }

  const dashboard = `${config.storeUrl}/pages/creator-dashboard`;
  await emails.welcome(updated.email, {
    name: updated.name, code, links: creatorLinks(code), dashboard, spotlight: updated.level === 'spotlight',
  });
  return updated;
}
