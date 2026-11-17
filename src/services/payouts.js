import { q, tx, audit } from '../db.js';
import * as rzp from '../integrations/razorpayx.js';
import { decrypt, encrypt, hashId } from '../lib/crypto.js';
import { emails } from '../integrations/email.js';
import { config } from '../config.js';

const NAME_MATCH_MIN = Number(process.env.NAME_MATCH_MIN || '0.6');

/**
 * Create (or replace) the creator's RazorpayX contact and fund account from their encrypted payout details.
 * If account validation is switched on, a name mismatch returns { ok:false } and nothing is saved.
 */
export async function setupFundAccount(creator, { payout = null } = {}) {
  if (!rzp.configured()) return { ok: true, skipped: 'razorpayx_not_configured' };
  const details = payout || JSON.parse(decrypt(creator.payout_enc));
  const method = payout?.method || creator.payout_method;
  const mobile = creator.mobile_plain || undefined;

  let contactId = creator.rzp_contact_id;
  if (!contactId) {
    const contact = await rzp.createContact({ name: creator.pan_name || creator.name, email: creator.email, mobile, creatorId: creator.id });
    contactId = contact.id;
    await q('UPDATE creators SET rzp_contact_id=$2 WHERE id=$1', [creator.id, contactId]);
  }
  const fa = await rzp.createFundAccount({ contactId, method, vpa: details.vpa, account: details.account, ifsc: details.ifsc, holderName: creator.pan_name || creator.name });

  let registeredName = null;
  if (rzp.validationEnabled()) {
    const v = await rzp.validateFundAccount({ fundAccountId: fa.id, creatorId: creator.id });
    registeredName = v.registeredName;
    const score = rzp.nameMatch(creator.pan_name, registeredName);
    if (!v.ok || score < NAME_MATCH_MIN) {
      await audit('system', 'creator', creator.id, 'fund_account_rejected', null, { status: v.status, score });
      return { ok: false, reason: !v.ok ? 'The account could not be verified.' : 'The name on the account does not match the name on your PAN.' };
    }
  }
  await q('UPDATE creators SET rzp_fund_account_id=$2, payout_validated_name=$3, updated_at=now() WHERE id=$1', [creator.id, fa.id, registeredName]);
  await audit('system', 'creator', creator.id, 'fund_account_created', null, { fundAccountId: fa.id, method });
  return { ok: true, fundAccountId: fa.id };
}

/** Creator changes payout details: new fund account, 72-hour hold, email to the address on file. */
export async function changePayoutDetails(creator, payout) {
  const payoutHash = hashId(payout.key);
  const dup = await q('SELECT 1 FROM creators WHERE id<>$1 AND payout_hash=$2', [creator.id, payoutHash]);
  if (dup.rowCount) return { ok: false, reason: 'That account is already registered to another creator.' };
  const r = await setupFundAccount(creator, { payout });
  if (!r.ok) return r;
  const holdUntil = new Date(Date.now() + config.payouts.detailsChangeHoldHours * 3600000);
  await q(`UPDATE creators SET payout_method=$2, payout_enc=$3, payout_hash=$4, payout_last4=$5, payout_hold_until=$6, payout_changed_at=now(), updated_at=now() WHERE id=$1`,
    [creator.id, payout.method,
      encrypt(JSON.stringify(payout.method === 'bank' ? { account: payout.account, ifsc: payout.ifsc } : { vpa: payout.vpa })),
      payoutHash, payout.last4, holdUntil]);
  await audit('creator', 'creator', creator.id, 'payout_details_changed', { last4: creator.payout_last4 }, { last4: payout.last4 });
  await emails.payoutDetailsChanged(creator.email, { name: creator.name, last4: payout.last4 });
  return { ok: true, holdUntil };
}

/** RazorpayX payout webhooks: processed → store UTR; failed or reversed → money back to the creator's balance. */
export async function handlePayoutEvent(event) {
  const p = event?.payload?.payout?.entity;
  if (!p?.reference_id) return { ignored: true };
  const row = (await q('SELECT * FROM payouts WHERE reference_id=$1', [p.reference_id])).rows[0];
  if (!row) return { ignored: true, reason: 'unknown reference' };

  if (event.event === 'payout.processed') {
    await q(`UPDATE payouts SET status='processed', utr=$2, rzp_payout_id=$3, paid_at=now(), failure_reason=NULL WHERE id=$1`, [row.id, p.utr || null, p.id]);
    return { processed: true };
  }
  if (['payout.failed', 'payout.reversed', 'payout.rejected'].includes(event.event)) {
    if (['reversed'].includes(row.status)) return { duplicate: true };
    const reason = p.status_details?.description || p.failure_reason || event.event;
    const creator = (await q('SELECT * FROM creators WHERE id=$1', [row.creator_id])).rows[0];
    await tx(async (client) => {
      await client.query(`UPDATE payouts SET status='reversed', failure_reason=$2, rzp_payout_id=$3 WHERE id=$1`, [row.id, String(reason).slice(0, 300), p.id]);
      // The net amount goes back on the creator's balance for the next run. TDS already deducted stays deducted.
      await client.query('INSERT INTO adjustments (creator_id, amount_paise, reason) VALUES ($1,$2,$3)',
        [row.creator_id, row.net_paise, `Payout ${row.run_id} returned: ${String(reason).slice(0, 120)}`]);
      // Hold further payouts until the creator gives working details.
      await client.query(`UPDATE creators SET payout_hold_until = now() + interval '3650 days' WHERE id=$1`, [row.creator_id]);
    });
    await emails.payoutFailed(creator.email, { name: creator.name, reason });
    await emails.ownerDigest(`Creator payout returned: ${creator.code}`, `<p>${creator.code}'s payout for ${row.run_id} was returned: ${reason}. The amount is back on their balance and further payouts are held until they update their details.</p>`);
    return { reversed: true };
  }
  if (['payout.queued', 'payout.initiated', 'payout.pending'].includes(event.event)) {
    await q(`UPDATE payouts SET status=CASE WHEN status IN ('processed','reversed') THEN status ELSE 'processing' END, rzp_payout_id=$2 WHERE id=$1`, [row.id, p.id]);
  }
  return { ok: true };
}
