// All programme rules live here as config values, not constants scattered in code.
// Secrets come only from environment variables set in Railway. Never commit them.

const env = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback === undefined) throw new Error(`Missing environment variable ${name}`);
    return fallback;
  }
  return v;
};
const bool = (name, fallback) => String(env(name, String(fallback))).toLowerCase() === 'true';
const int = (name, fallback) => parseInt(env(name, String(fallback)), 10);

export const config = {
  env: env('NODE_ENV', 'development'),
  port: int('PORT', 3000),
  baseUrl: env('BASE_URL', 'http://localhost:3000'), // e.g. https://creators.clockworkrituals.com
  storeUrl: env('STORE_URL', 'https://www.clockworkrituals.com'),
  databaseUrl: env('DATABASE_URL', 'postgres://localhost:5432/clockwork_creators'),

  // DRY_RUN: statements are calculated and emailed, no money moves. Rohan switches it off himself.
  dryRun: bool('DRY_RUN', true),
  schedulerEnabled: bool('SCHEDULER_ENABLED', true),

  secrets: {
    // 32-byte keys, hex encoded. Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    dataKey: env('DATA_ENCRYPTION_KEY', ''), // encrypts PAN and payout details at rest
    signingKey: env('SIGNING_KEY', ''), // signs magic links, email verification, sessions
    hashPepper: env('HASH_PEPPER', ''), // hashes phone, email, address, IP for matching
  },

  shopify: {
    shop: env('SHOPIFY_SHOP', ''), // e.g. clockworkrituals.myshopify.com
    adminToken: env('SHOPIFY_ADMIN_TOKEN', ''),
    apiVersion: env('SHOPIFY_API_VERSION', '2026-10'),
    webhookSecret: env('SHOPIFY_WEBHOOK_SECRET', ''),
    // Automated collection of every product except dentist-partner-kit. The creator discount applies to this collection.
    eligibleCollectionId: env('SHOPIFY_CREATOR_COLLECTION_ID', ''),
    excludedHandles: env('EXCLUDED_PRODUCT_HANDLES', 'dentist-partner-kit').split(',').map((s) => s.trim()),
    defaultLandingPath: env('DEFAULT_LANDING_PATH', '/products/peppermint-toothpaste-with-nhap'),
  },

  meta: {
    appId: env('META_APP_ID', '1676163180532531'),
    appSecret: env('META_APP_SECRET', ''),
    // Unified login configuration ID from the Meta app (Facebook Login for Business → Configurations)
    loginConfigId: env('META_LOGIN_CONFIG_ID', ''),
    authorizeUrl: env('META_AUTHORIZE_URL', 'https://www.instagram.com/oauth/authorize'),
    tokenUrl: env('META_TOKEN_URL', 'https://api.instagram.com/oauth/access_token'),
    graphBase: env('META_GRAPH_BASE', 'https://graph.instagram.com'),
    graphVersion: env('META_GRAPH_VERSION', 'v23.0'),
    scopes: env('META_SCOPES', 'instagram_business_basic,instagram_business_manage_insights'),
  },

  email: {
    resendKey: env('RESEND_API_KEY', ''),
    from: env('EMAIL_FROM', 'Clockwork Creators <partners@clockworkrituals.com>'),
    replyTo: env('EMAIL_REPLY_TO', 'partners@clockworkrituals.com'),
    ownerDigest: env('OWNER_EMAIL', 'partners@clockworkrituals.com'),
  },

  qualification: {
    minFollowers: int('MIN_FOLLOWERS', 3000),
    minIndiaShare: Number(env('MIN_INDIA_SHARE', '0.6')),
    minMedianViewRatio: Number(env('MIN_MEDIAN_VIEW_RATIO', '0.10')),
    maxFollowerJump7d: Number(env('MAX_FOLLOWER_JUMP_7D', '0.30')),
    minReels: int('MIN_REELS', 12),
    maxDaysSinceLastReel: int('MAX_DAYS_SINCE_LAST_REEL', 30),
    spotlightMedianViews: int('SPOTLIGHT_MEDIAN_VIEWS', 50000),
    reapplyAfterDays: int('REAPPLY_AFTER_DAYS', 30),
    blockedKeywords: env('BLOCKED_KEYWORDS', 'coupon,deals,offers,cashback,discount,promo,grabon,couponzguru,cashkaro')
      .split(',').map((s) => s.trim().toLowerCase()),
    staffDomains: env('STAFF_DOMAINS', 'clockworkrituals.com').split(',').map((s) => s.trim().toLowerCase()),
    reservedCodePrefixes: ['FIRST', 'SALE', 'CW', 'CLOCKWORK'],
  },

  commission: {
    flatNewCustomerPaise: int('FLAT_NEW_CUSTOMER_PAISE', 30000), // ₹300
    campaignEndsAt: env('CAMPAIGN_ENDS_AT', '2027-06-30T23:59:59+05:30'),
    tiers: [
      { name: 'starter', label: 'Starter', rateBps: int('TIER_STARTER_BPS', 1000), minOrders: 0 },
      { name: 'pro', label: 'Pro', rateBps: int('TIER_PRO_BPS', 1500), minOrders: int('TIER_PRO_ORDERS', 25) },
      { name: 'elite', label: 'Elite', rateBps: int('TIER_ELITE_BPS', 2000), minOrders: int('TIER_ELITE_ORDERS', 100) },
    ],
    defaultGstRate: Number(env('DEFAULT_GST_RATE', '0.18')),
    holdDaysAfterDelivery: int('HOLD_DAYS_AFTER_DELIVERY', 7),
    negativeWriteOffMonths: int('NEGATIVE_WRITE_OFF_MONTHS', 6),
    countedCodTags: ['Order Confirmed', 'COD-Advance-Paid', 'Paid-Razorpay-Link'],
    excludedCodTags: ['COD-Unconfirmed', 'COD-Cancelled-Unconfirmed'],
  },

  payouts: {
    minPayoutPaise: int('MIN_PAYOUT_PAISE', 50000), // ₹500
    weeklyDuringCampaign: bool('WEEKLY_DURING_CAMPAIGN', true),
    detailsChangeHoldHours: int('DETAILS_CHANGE_HOLD_HOURS', 72),
  },

  tds: {
    // Confirm with the CA before launch: section, rate and threshold.
    sectionLabel: env('TDS_SECTION_LABEL', '194H (Income-tax Act, 1961) / successor under Income-tax Act, 2025'),
    rateBps: int('TDS_RATE_BPS', 200), // 2%
    noPanRateBps: int('TDS_NO_PAN_RATE_BPS', 2000), // 20%
    annualThresholdPaise: int('TDS_THRESHOLD_PAISE', 2000000), // ₹20,000
  },

  fraud: {
    velocityMultiple: Number(env('FRAUD_VELOCITY_MULTIPLE', '5')),
    pincodeShareMax: Number(env('FRAUD_PINCODE_SHARE_MAX', '0.30')),
    codCancelShareMax: Number(env('FRAUD_COD_CANCEL_SHARE_MAX', '0.40')),
    extraHoldDays: int('FRAUD_EXTRA_HOLD_DAYS', 14),
  },

  repeat: {
    minRatio: Number(env('REPEAT_MIN_RATIO', '0.30')),
    daysPerTube: int('REPEAT_DAYS_PER_TUBE', 50),
    graceDays: int('REPEAT_GRACE_DAYS', 30),
    minDueCustomers: int('REPEAT_MIN_DUE', 20),
    startAfterMonths: int('REPEAT_START_AFTER_MONTHS', 2),
  },

  termsVersion: env('TERMS_VERSION', '2026-11-16'),
};

export function requireSecrets(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) throw new Error(`Missing secrets: ${missing.join(', ')}`);
}
