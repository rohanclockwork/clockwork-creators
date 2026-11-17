# Clockwork Creators

The service behind the Clockwork Creator Programme: Instagram-verified sign-up, creator codes, order attribution, the ₹300 launch offer, tiers, fraud checks and statements.

**Payouts:** RazorpayX. With `DRY_RUN=true` (the default) payout runs only calculate, and Rohan alone gets the statements. With `DRY_RUN=false` and **test** keys (`rzp_test_…`) the whole flow runs against RazorpayX test mode (run IDs start `test-`). With live keys, money moves. Each payout's reference and idempotency key is `<runId>-<creatorId>`, and a run for a period that already exists is refused.

## How it works

1. A creator opens `https://creators.clockworkrituals.com` and connects Instagram.
2. The service reads followers, the last reels' views, audience countries and 30 days of follower counts, and decides automatically (see `src/lib/qualify.js`). No manual review.
3. Qualified creators add name, email, mobile, PAN and payout details (PAN and payout details encrypted at rest). Spotlight creators also give an address for their free tube.
4. Email confirmed → a Shopify discount code (10% off, once per customer, shipping-only combinations, eligible collection only) is created and the welcome email sent. Spotlight creators get a ₹0 order for one tube, created automatically.
5. Shopify webhooks plus a nightly 45-day reconcile attribute every order to a code and move it through pending → qualifying (7 days after delivery) → locked.
6. Every Monday during the campaign (the 5th of each month afterwards) the payout run applies fraud holds and the repeat check, works out TDS, and writes statements.

Rules and thresholds live in `src/config.js` and can all be overridden with environment variables (see `CONFIG.md`).

## Deploy on Railway (Rohan)

### 1. Shopify: one collection and one custom app

- **Collection:** Shopify admin → Products → Collections → Create collection. Title `Creator programme eligible`, type **Automated**, condition **Product tag is not equal to `partner-kit`**. Remove it from the Online Store sales channel so it doesn't show on the site. Copy its ID from the address bar (the number at the end) → `SHOPIFY_CREATOR_COLLECTION_ID=gid://shopify/Collection/<number>`.
- **Custom app:** Settings → Apps and sales channels → Develop apps → Create an app, name `Clockwork Creators`. Admin API scopes: `read_orders`, `read_all_orders`, `read_products`, `write_discounts`, `read_discounts`, `write_draft_orders`, `read_customers`. Install it, then copy the **Admin API access token** (shown once) and the **API secret key**.
  - Access token → `SHOPIFY_ADMIN_TOKEN`
  - API secret key → `SHOPIFY_WEBHOOK_SECRET` (Shopify signs webhooks with it)

### 2. Resend (email)

Create an account at resend.com, add the domain `clockworkrituals.com`, and add the DNS records it shows (in your DNS provider). Create an API key → `RESEND_API_KEY`.

### 3. Railway

1. New project → Deploy from GitHub repo → `rohanclockwork/clockwork-creators`.
2. Add a **PostgreSQL** database to the project. Railway sets `DATABASE_URL` for you; reference it in the service variables.
3. Settings → Networking → add the custom domain `creators.clockworkrituals.com`, then add the CNAME record Railway shows in your DNS.
4. Variables → add every line below. **Paste secrets straight into Railway. Never into chat, email or the repo.**

```
NODE_ENV=production
BASE_URL=https://creators.clockworkrituals.com
DRY_RUN=true
DATABASE_URL=${{Postgres.DATABASE_URL}}

# Generate each of these three with:  openssl rand -hex 32
DATA_ENCRYPTION_KEY=
SIGNING_KEY=
HASH_PEPPER=

SHOPIFY_SHOP=<your-store>.myshopify.com
SHOPIFY_ADMIN_TOKEN=
SHOPIFY_WEBHOOK_SECRET=
SHOPIFY_CREATOR_COLLECTION_ID=gid://shopify/Collection/
KIT_VARIANT_ID=gid://shopify/ProductVariant/45143289266367

META_APP_ID=1676163180532531
META_APP_SECRET=          # Meta app → App settings → Basic → App secret

RESEND_API_KEY=
OWNER_EMAIL=partners@clockworkrituals.com
```

Keep `DATA_ENCRYPTION_KEY` safe elsewhere too (a password manager). If it is lost, stored PANs and payout details can't be read.

### 4. After the first deploy (once)

In the Railway service → the three-dot menu → **Run command** (or `railway run` locally):

```
npm run job -- webhooks     # subscribes Shopify order and refund webhooks to this service
npm run job -- backfill     # reads every past order so "new customer" is judged against all history
```

### 5. Meta login

- Meta app → Instagram use case → API setup → add the redirect URL `https://creators.clockworkrituals.com/auth/instagram/callback`.
- Create a login configuration that asks only for `instagram_business_basic` and `instagram_business_manage_insights`. If Meta gives a configuration ID, set `META_LOGIN_CONFIG_ID`. If its login URL differs from `https://www.instagram.com/oauth/authorize`, set `META_AUTHORIZE_URL`.
- Add your own Instagram account as a tester (App roles → Roles → Instagram testers) and sign up with it end to end. This works before App Review.
- Then submit App Review with a screen recording of that sign-up.

## Running locally

```
npm install
createdb clockwork_creators
cp .env.example .env   # fill in; secrets stay local
npm test               # rules tests
TEST_DATABASE_URL=postgres://localhost/clockwork_creators_test npm test   # plus database tests
node --env-file=.env src/server.js
```

## Jobs

Scheduled inside the service (Asia/Kolkata). Run any by hand with `npm run job -- <name>`.

| Job | When | What |
|---|---|---|
| `reconcile` | Nightly 02:30 | Re-reads 45 days of orders; moves orders through the 7-day window |
| `posts` | Daily 11:00 | Checks creators' Clockwork captions for disclosure and banned claims |
| `tiers` | 1st, 00:30 | Tiers from last month's orders, with one month's grace |
| `recheck` | 2nd, 04:00 | Re-reads each creator's Instagram, refreshes tokens, pauses after two months below the bar |
| `payouts` | Mondays 10:00 during the campaign; the 5th after | Fraud holds, repeat check, TDS, statements (DRY_RUN: to Rohan only) |
| `summary` | Mondays 09:00 | Rohan's weekly summary with the halo estimate |

A payout run for a period that already exists is refused (never pay twice). `npm run job -- payouts --force` re-runs a dry run.

## RazorpayX set-up

1. Railway → creators-app → Settings → Networking → enable **Static Outbound IPs** (Pro plan). Add every IP shown to RazorpayX's IP allowlist.
2. RazorpayX dashboard, **test mode** first: generate API keys → `RAZORPAYX_KEY_ID`, `RAZORPAYX_KEY_SECRET`. Business account number → `RAZORPAYX_ACCOUNT_NUMBER` (different in test and live mode).
3. RazorpayX webhooks: URL `https://creators.clockworkrituals.com/webhooks/razorpayx`, events `payout.processed`, `payout.failed`, `payout.reversed`, `payout.rejected`, `payout.queued`, `payout.initiated`; a secret → `RAZORPAYX_WEBHOOK_SECRET`.
4. `RAZORPAYX_VALIDATE_ACCOUNTS=true` only if your RazorpayX account supports Account Validation (penny drop). RazorpayX documents it as unavailable in test mode and limited to RazorpayX Lite. With it on, a creator's account name must match their PAN name (`NAME_MATCH_MIN`, default 0.6).

## Going live with payouts

1. Set `DRY_RUN=false` with **test** keys. Sign up yourself as a creator, place and deliver a test order, run `npm run job -- payouts`, and check the payout appears in RazorpayX test mode, the webhook stores a UTR, and the statement email arrives.
2. Swap to live keys and the live account number. Do a ₹1 live payout to your own UPI (your own sign-up, with `MIN_PAYOUT_PAISE=100` for that one run, then back to `50000`).
3. Keep the business account funded: payouts queue when the balance is low (`queue_if_low_balance`), and RazorpayX's dashboard low-balance alert covers this.

Returned payouts (`payout.failed` / `payout.reversed`) put the money back on the creator's balance, hold further payouts and email the creator. A changed UPI or bank account waits 72 hours before it is paid. Every quarter (7 Jan/Apr/Jul/Oct) Rohan gets a CSV of PAN, name, amount credited and TDS for the CA (`npm run job -- tds`).

## Check with the CA before launch

TDS section, rate (2%) and threshold (₹20,000 a year) are config values: `TDS_SECTION_LABEL`, `TDS_RATE_BPS`, `TDS_THRESHOLD_PAISE`.
