-- All money in paise (integers). All times in UTC (timestamptz).

CREATE TABLE IF NOT EXISTS creators (
  id               BIGSERIAL PRIMARY KEY,
  status           TEXT NOT NULL DEFAULT 'pending_email'
                   CHECK (status IN ('ig_connected','pending_email','active','rejected','paused','suspended','left')),
  level            TEXT NOT NULL DEFAULT 'creator' CHECK (level IN ('creator','spotlight')),
  name             TEXT,
  email            TEXT UNIQUE,
  email_verified_at TIMESTAMPTZ,
  mobile_hash      TEXT UNIQUE,
  mobile_last4     TEXT,
  ig_user_id       TEXT UNIQUE NOT NULL,
  ig_username      TEXT NOT NULL,
  ig_token_enc     TEXT,
  ig_token_expires_at TIMESTAMPTZ,
  ig_snapshot      JSONB,             -- latest qualification numbers
  code             TEXT UNIQUE,
  shopify_discount_id TEXT,
  tier             TEXT NOT NULL DEFAULT 'starter',
  tier_since       DATE,
  grace_until      DATE,
  flat_rate_ended_at TIMESTAMPTZ,      -- set when the repeat check moves a creator off ₹300
  pan_enc          TEXT,
  pan_hash         TEXT UNIQUE,
  pan_last4        TEXT,
  pan_name         TEXT,
  gstin            TEXT,
  payout_method    TEXT CHECK (payout_method IN ('upi','bank')),
  payout_enc       TEXT,               -- encrypted JSON: {vpa} or {account, ifsc}
  payout_hash      TEXT UNIQUE,
  payout_last4     TEXT,
  payout_hold_until TIMESTAMPTZ,
  rzp_contact_id   TEXT,
  rzp_fund_account_id TEXT,
  address_hashes   TEXT[] NOT NULL DEFAULT '{}', -- creator's own delivery addresses, if known
  reject_reason    TEXT,
  reapply_after    TIMESTAMPTZ,
  below_bar_months INT NOT NULL DEFAULT 0,
  terms_version    TEXT,
  terms_accepted_at TIMESTAMPTZ,
  marketing_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  ip_hash          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every identity (email, phone, address) ever seen on any order, so "new customer" is checked against all history.
CREATE TABLE IF NOT EXISTS identities (
  kind        TEXT NOT NULL CHECK (kind IN ('email','phone','address')),
  hash        TEXT NOT NULL,
  first_order_id TEXT NOT NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL,
  flat_paid_order_id TEXT,             -- the order that earned a ₹300 payment for this identity, if any
  PRIMARY KEY (kind, hash)
);

CREATE TABLE IF NOT EXISTS attributions (
  order_id        TEXT PRIMARY KEY,    -- Shopify order GID
  order_name      TEXT NOT NULL,
  creator_id      BIGINT NOT NULL REFERENCES creators(id),
  code            TEXT NOT NULL,
  placed_at       TIMESTAMPTZ NOT NULL,
  delivered_at    TIMESTAMPTZ,
  is_new_customer BOOLEAN NOT NULL,
  tubes           INT NOT NULL DEFAULT 1,
  pincode_hash    TEXT,
  is_cod          BOOLEAN NOT NULL DEFAULT FALSE,
  base_paise      BIGINT NOT NULL DEFAULT 0,
  basis           TEXT NOT NULL CHECK (basis IN ('flat','percent','none')),
  rate_bps        INT,
  commission_paise BIGINT NOT NULL DEFAULT 0,
  state           TEXT NOT NULL CHECK (state IN ('pending','qualifying','locked','held','reversed','rejected')),
  reason          TEXT,
  hold_until      TIMESTAMPTZ,
  paid_in_payout_id BIGINT,
  last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attributions_creator_idx ON attributions (creator_id, state);

CREATE TABLE IF NOT EXISTS customer_orders (
  -- Every order (coded or not) by a customer a creator brought, for the repeat check.
  order_id     TEXT PRIMARY KEY,
  email_hash   TEXT,
  phone_hash   TEXT,
  placed_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS customer_orders_email_idx ON customer_orders (email_hash);
CREATE INDEX IF NOT EXISTS customer_orders_phone_idx ON customer_orders (phone_hash);

CREATE TABLE IF NOT EXISTS adjustments (
  id           BIGSERIAL PRIMARY KEY,
  creator_id   BIGINT NOT NULL REFERENCES creators(id),
  order_id     TEXT,
  amount_paise BIGINT NOT NULL,        -- negative for clawbacks
  reason       TEXT NOT NULL,
  applied_in_payout_id BIGINT,
  written_off_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payout_runs (
  run_id       TEXT PRIMARY KEY,        -- e.g. 2026-W51 or 2027-07
  period_start TIMESTAMPTZ NOT NULL,
  period_end   TIMESTAMPTZ NOT NULL,
  dry_run      BOOLEAN NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','finished','failed')),
  totals       JSONB,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS payouts (
  id             BIGSERIAL PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES payout_runs(run_id),
  creator_id     BIGINT NOT NULL REFERENCES creators(id),
  gross_paise    BIGINT NOT NULL,
  adjustments_paise BIGINT NOT NULL DEFAULT 0,
  carry_in_paise BIGINT NOT NULL DEFAULT 0,
  tds_paise      BIGINT NOT NULL DEFAULT 0,
  net_paise      BIGINT NOT NULL,
  carry_out_paise BIGINT NOT NULL DEFAULT 0,
  status         TEXT NOT NULL CHECK (status IN ('dry_run','carried','queued','processing','processed','failed','reversed')),
  rzp_payout_id  TEXT,
  utr            TEXT,
  failure_reason TEXT,
  fy             TEXT NOT NULL,          -- e.g. 2026-27
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, creator_id)
);

CREATE TABLE IF NOT EXISTS clicks (
  id         BIGSERIAL PRIMARY KEY,
  creator_id BIGINT NOT NULL REFERENCES creators(id),
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_hash    TEXT,
  ua         TEXT,
  referer    TEXT,
  landing    TEXT
);

CREATE TABLE IF NOT EXISTS post_checks (
  media_id    TEXT PRIMARY KEY,
  creator_id  BIGINT NOT NULL REFERENCES creators(id),
  permalink   TEXT,
  posted_at   TIMESTAMPTZ,
  views       BIGINT,
  disclosed   BOOLEAN NOT NULL,
  banned_terms TEXT[] NOT NULL DEFAULT '{}',
  ok          BOOLEAN NOT NULL,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signup_ips (
  ip_hash TEXT NOT NULL,
  ts      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        BIGSERIAL PRIMARY KEY,
  ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor     TEXT NOT NULL,               -- 'system' or 'rohan'
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action    TEXT NOT NULL,
  before    JSONB,
  after     JSONB
);

CREATE TABLE IF NOT EXISTS job_locks (
  name      TEXT PRIMARY KEY,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
