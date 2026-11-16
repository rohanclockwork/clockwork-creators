import { config } from '../config.js';
import { hashId, normaliseEmail, normalisePhone, normaliseAddress } from '../lib/crypto.js';

const s = config.shopify;

export async function gql(query, variables = {}) {
  const res = await fetch(`https://${s.shop}/admin/api/${s.apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': s.adminToken },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 2000));
    return gql(query, variables);
  }
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify: ${JSON.stringify(json.errors)}`);
  return json.data;
}

export const ORDER_FIELDS = `
  id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus tags sourceName
  email phone
  customer { id }
  discountCodes
  customAttributes { key value }
  shippingAddress { address1 address2 zip phone }
  currentSubtotalPriceSet { shopMoney { amount } }
  currentTotalTaxSet { shopMoney { amount } }
  totalRefundedSet { shopMoney { amount } }
  totalPriceSet { shopMoney { amount } }
  fulfillments { status displayStatus deliveredAt createdAt }
  lineItems(first: 50) {
    nodes {
      quantity currentQuantity
      product { handle }
      variant { title }
      originalTotalSet { shopMoney { amount } }
      discountAllocations { allocatedAmountSet { shopMoney { amount } } }
      taxLines { priceSet { shopMoney { amount } } }
    }
  }
`;

const paise = (m) => Math.round(Number(m?.shopMoney?.amount || 0) * 100);

// "2 tubes", "4 Tubes" in the variant title count as that many tubes.
const tubesPerUnit = (variantTitle) => {
  const m = /(\d+)\s*tube/i.exec(variantTitle || '');
  return m ? parseInt(m[1], 10) : 1;
};

export function normaliseOrder(o) {
  const delivered = (o.fulfillments || []).map((f) => f.deliveredAt).filter(Boolean).sort()[0] || null;
  const email = normaliseEmail(o.email);
  const phone = normalisePhone(o.phone || o.shippingAddress?.phone);
  const address = normaliseAddress(o.shippingAddress);
  const total = paise(o.totalPriceSet);
  const refunded = paise(o.totalRefundedSet);
  return {
    id: o.id,
    name: o.name,
    placedAt: o.createdAt,
    cancelledAt: o.cancelledAt,
    financialStatus: o.displayFinancialStatus,
    fulfilled: o.displayFulfillmentStatus === 'FULFILLED',
    deliveredAt: delivered,
    tags: o.tags || [],
    // Staff-created orders: draft orders and POS. (staffMember needs a scope this store can't grant.)
    isStaff: ['shopify_draft_order', 'pos'].includes(o.sourceName),
    isCod: (o.tags || []).some((t) => /^COD/i.test(t) || t === 'Order Confirmed'),
    discountCodes: (o.discountCodes || []).map((c) => c.toUpperCase()),
    attributes: Object.fromEntries((o.customAttributes || []).map((a) => [a.key, a.value])),
    fullyRefunded: total > 0 && refunded >= total,
    emailHash: hashId(email),
    phoneHash: hashId(phone),
    addressHash: hashId(address),
    pincodeHash: hashId(o.shippingAddress?.zip),
    lineItems: (o.lineItems?.nodes || []).map((li) => ({
      handle: li.product?.handle || '',
      quantity: li.quantity,
      currentQuantity: li.currentQuantity,
      // After every discount allocated to this line, including order-level codes.
      discountedTotalPaise: paise(li.originalTotalSet) - (li.discountAllocations || []).reduce((n, a) => n + paise(a.allocatedAmountSet), 0),
      taxPaise: (li.taxLines || []).reduce((n, t) => n + paise(t.priceSet), 0),
      tubesPerUnit: tubesPerUnit(li.variant?.title),
    })),
  };
}

export async function getOrder(id) {
  const d = await gql(`query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id });
  return d.order ? normaliseOrder(d.order) : null;
}

/** Iterate orders updated since a date (for the nightly reconcile and the first backfill). */
export async function* ordersUpdatedSince(sinceIso, { createdSince = false } = {}) {
  let after = null;
  const field = createdSince ? 'created_at' : 'updated_at';
  for (;;) {
    const d = await gql(
      `query($q: String!, $after: String) { orders(first: 50, after: $after, query: $q, sortKey: UPDATED_AT) {
         nodes { ${ORDER_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
      { q: `${field}:>='${sinceIso}'`, after },
    );
    for (const o of d.orders.nodes) yield normaliseOrder(o);
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
  }
}

export async function codeTaken(code) {
  const d = await gql(`query($code: String!) { codeDiscountNodeByCode(code: $code) { id } }`, { code });
  return Boolean(d.codeDiscountNodeByCode);
}

/** One basic code discount per creator: 10% off eligible products, once per customer, combines with shipping only. */
export async function createCreatorDiscount({ code, creatorId }) {
  const d = await gql(
    `mutation($input: DiscountCodeBasicInput!) { discountCodeBasicCreate(basicCodeDiscount: $input) {
       codeDiscountNode { id } userErrors { field message } } }`,
    {
      input: {
        title: `Creator ${code} (#${creatorId})`,
        code,
        startsAt: new Date().toISOString(),
        appliesOncePerCustomer: true,
        combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
        customerGets: {
          value: { percentage: 0.1 },
          items: { collections: { add: [s.eligibleCollectionId] } },
        },
        context: { all: 'ALL' },
        tags: ['creator-programme'],
      },
    },
  );
  const r = d.discountCodeBasicCreate;
  if (r.userErrors.length) throw new Error(`Discount create failed: ${JSON.stringify(r.userErrors)}`);
  return r.codeDiscountNode.id;
}

export async function deactivateDiscount(id) {
  const d = await gql(
    `mutation($id: ID!) { discountCodeDeactivate(id: $id) { userErrors { field message } } }`, { id },
  );
  if (d.discountCodeDeactivate.userErrors.length) throw new Error(JSON.stringify(d.discountCodeDeactivate.userErrors));
}

export async function subscribeWebhooks(callbackBase) {
  const topics = ['ORDERS_CREATE', 'ORDERS_UPDATED', 'ORDERS_CANCELLED', 'REFUNDS_CREATE'];
  const out = [];
  for (const topic of topics) {
    const d = await gql(
      `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
         webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
           webhookSubscription { id } userErrors { field message } } }`,
      { topic, sub: { uri: `${callbackBase}/webhooks/shopify`, format: 'JSON' } },
    );
    out.push({ topic, ...d.webhookSubscriptionCreate });
  }
  return out;
}

export function creatorLinks(code, platform = 'instagram') {
  const utm = `utm_source=creator&utm_medium=${encodeURIComponent(platform)}&utm_campaign=${encodeURIComponent(code)}`;
  const link = (path) => `${config.storeUrl}/discount/${encodeURIComponent(code)}?redirect=${encodeURIComponent(path)}&${utm}`;
  return {
    daily: link(s.defaultLandingPath),
    shop: link('/collections/all'),
  };
}
