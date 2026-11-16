# Programme settings

Every rule below is an environment variable in Railway. Change it there and redeploy; no code change needed. Money is in paise (₹1 = 100 paise); rates in basis points (1% = 100).

| Setting | Variable | Default |
|---|---|---|
| Flat payment per new customer | `FLAT_NEW_CUSTOMER_PAISE` | `30000` (₹300) |
| Campaign end | `CAMPAIGN_ENDS_AT` | `2027-06-30T23:59:59+05:30` |
| Starter / Pro / Elite rates | `TIER_STARTER_BPS` / `TIER_PRO_BPS` / `TIER_ELITE_BPS` | 1000 / 1500 / 2000 |
| Orders a month for Pro / Elite | `TIER_PRO_ORDERS` / `TIER_ELITE_ORDERS` | 25 / 100 |
| Days after delivery before an order counts | `HOLD_DAYS_AFTER_DELIVERY` | 7 |
| Minimum payout | `MIN_PAYOUT_PAISE` | `50000` (₹500) |
| Weekly payouts during the campaign | `WEEKLY_DURING_CAMPAIGN` | `true` |
| Follower minimum | `MIN_FOLLOWERS` | 3000 |
| Share of audience in India | `MIN_INDIA_SHARE` | 0.6 |
| Median reel views ÷ followers | `MIN_MEDIAN_VIEW_RATIO` | 0.10 |
| Largest 7-day follower jump allowed | `MAX_FOLLOWER_JUMP_7D` | 0.30 |
| Reels needed / days since last reel | `MIN_REELS` / `MAX_DAYS_SINCE_LAST_REEL` | 12 / 30 |
| Spotlight median views (free tube) | `SPOTLIGHT_MEDIAN_VIEWS` | 50000 |
| Coupon-account keywords | `BLOCKED_KEYWORDS` | coupon, deals, offers, cashback, discount, promo, grabon, couponzguru, cashkaro |
| Repeat check: minimum reorder rate | `REPEAT_MIN_RATIO` | 0.30 |
| Repeat check: days per tube + grace | `REPEAT_DAYS_PER_TUBE` / `REPEAT_GRACE_DAYS` | 50 / 30 |
| Repeat check: customers due before it applies | `REPEAT_MIN_DUE` | 20 |
| Fraud: spike multiple / pincode share / COD cancel share | `FRAUD_VELOCITY_MULTIPLE` / `FRAUD_PINCODE_SHARE_MAX` / `FRAUD_COD_CANCEL_SHARE_MAX` | 5 / 0.30 / 0.40 |
| Extra hold when a fraud signal fires | `FRAUD_EXTRA_HOLD_DAYS` | 14 |
| TDS rate / no-PAN rate / yearly threshold | `TDS_RATE_BPS` / `TDS_NO_PAN_RATE_BPS` / `TDS_THRESHOLD_PAISE` | 200 / 2000 / 2000000 |
| Dentist referral markers (order tags or attributes) | `DENTIST_REFERRAL_MARKERS` | goaffpro, dentist-referral |
| Statements move no money | `DRY_RUN` | `true` |
