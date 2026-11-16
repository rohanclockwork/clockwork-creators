// Order evaluation: what an order is worth to a creator, and whether it qualifies yet.
// Pure functions over a normalised order shape (see integrations/shopify.js normaliseOrder).

const DAY = 86400000;

/** Merchandise value after discounts, before GST and shipping, net of refunds, excluding excluded products. Paise. */
export function commissionBasePaise(order, excludedHandles, defaultGstRate) {
  let base = 0;
  for (const li of order.lineItems) {
    if (excludedHandles.includes(li.handle)) continue;
    if (!li.quantity || !li.currentQuantity) continue;
    const share = li.currentQuantity / li.quantity;
    const gross = li.discountedTotalPaise * share; // GST-inclusive, after line and order discounts
    const tax = li.taxPaise != null && li.taxPaise > 0 ? li.taxPaise * share : gross - gross / (1 + defaultGstRate);
    base += gross - tax;
  }
  return Math.max(0, Math.floor(base));
}

export function tubesIn(order, excludedHandles) {
  return order.lineItems
    .filter((li) => !excludedHandles.includes(li.handle))
    .reduce((n, li) => n + (li.currentQuantity || 0) * (li.tubesPerUnit || 1), 0) || 1;
}

/** Is the order paid in a way that counts? */
export function isPaidOrConfirmed(order, rules) {
  if (order.tags.some((t) => rules.excludedCodTags.includes(t))) return false;
  if (['PAID', 'PARTIALLY_REFUNDED'].includes(order.financialStatus)) return true;
  if (order.tags.some((t) => rules.countedCodTags.includes(t)) && order.fulfilled) return true;
  return false;
}

export function tierRateBps(tierName, tiers) {
  return (tiers.find((t) => t.name === tierName) || tiers[0]).rateBps;
}

/**
 * Decide an order's attribution state and commission.
 * @param {object} p
 * @param {object} p.order normalised order
 * @param {object} p.creator { id, tier, flat_rate_ended_at, email_hash, phone_hash, address_hashes }
 * @param {boolean} p.isNewCustomer  no earlier order on this email, phone or address
 * @param {boolean} p.identityAlreadyPaidFlat  this email, phone or address already earned a ₹300 payment
 * @param {boolean} p.dentistReferral  order also came through the dentist programme
 * @param {object} p.cfg config.commission + config.shopify.excludedHandles
 * @param {Date} [p.now]
 */
export function evaluateOrder({ order, creator, isNewCustomer, identityAlreadyPaidFlat, dentistReferral, cfg, now = new Date() }) {
  const base = commissionBasePaise(order, cfg.excludedHandles, cfg.defaultGstRate);
  const campaignOpen = new Date(order.placedAt) <= new Date(cfg.campaignEndsAt);
  const flatAllowed = !creator.flat_rate_ended_at || new Date(order.placedAt) < new Date(creator.flat_rate_ended_at);

  let basis = 'percent';
  let rateBps = tierRateBps(creator.tier, cfg.tiers);
  let commission = Math.floor((base * rateBps) / 10000);
  if (isNewCustomer && !identityAlreadyPaidFlat && campaignOpen && flatAllowed) {
    basis = 'flat';
    rateBps = null;
    commission = cfg.flatNewCustomerPaise;
  }

  const reject = (reason) => ({ state: 'rejected', reason, basis: 'none', rateBps: null, commission: 0, base });

  if (dentistReferral) return reject('dentist_referral');
  if (order.isStaff) return reject('staff_order');
  if (order.emailHash && order.emailHash === creator.email_hash) return reject('self_purchase');
  if (order.phoneHash && order.phoneHash === creator.phone_hash) return reject('self_purchase');
  if (order.addressHash && (creator.address_hashes || []).includes(order.addressHash)) return reject('self_purchase');
  if (base === 0) return reject('no_eligible_items');

  if (order.cancelledAt) return { state: 'reversed', reason: 'cancelled', basis, rateBps, commission: 0, base };
  if (order.fullyRefunded) return { state: 'reversed', reason: 'refunded', basis, rateBps, commission: 0, base };
  if (order.tags.some((t) => cfg.excludedCodTags.includes(t))) return { state: 'pending', reason: 'cod_unconfirmed', basis, rateBps, commission, base };
  if (!isPaidOrConfirmed(order, cfg)) return { state: 'pending', reason: 'awaiting_payment', basis, rateBps, commission, base };
  if (!order.deliveredAt) return { state: 'pending', reason: 'awaiting_delivery', basis, rateBps, commission, base };

  const qualifiesAt = new Date(new Date(order.deliveredAt).getTime() + cfg.holdDaysAfterDelivery * DAY);
  if (now < qualifiesAt) return { state: 'qualifying', reason: 'return_window', basis, rateBps, commission, base, qualifiesAt };
  return { state: 'locked', reason: null, basis, rateBps, commission, base, qualifiesAt };
}

/** Commission to claw back when an order is refunded after it was paid. Returns a negative number or 0. */
export function clawbackPaise(paidCommission, newCommission) {
  return newCommission < paidCommission ? newCommission - paidCommission : 0;
}
