// Tiers, fraud signals, the repeat check and TDS. Pure functions.

const DAY = 86400000;

/**
 * Next tier from last month's qualifying orders, with one month's grace before dropping one level.
 * @returns {{tier:string, graceUntil:string|null, changed:boolean}}
 */
export function nextTier({ current, graceUntil, lastMonthOrders, tiers, monthStart }) {
  const order = tiers.map((t) => t.name);
  let earned = tiers[0].name;
  for (const t of tiers) if (lastMonthOrders >= t.minOrders) earned = t.name;
  const ci = order.indexOf(current);
  const ei = order.indexOf(earned);
  if (ei >= ci) return { tier: earned, graceUntil: null, changed: ei !== ci };
  // Below current tier: grace for one month, then down one level.
  if (!graceUntil) {
    const g = new Date(monthStart);
    g.setUTCMonth(g.getUTCMonth() + 1);
    return { tier: current, graceUntil: g.toISOString().slice(0, 10), changed: false };
  }
  if (new Date(monthStart) < new Date(graceUntil)) return { tier: current, graceUntil, changed: false };
  return { tier: order[ci - 1], graceUntil: null, changed: true };
}

/**
 * Order-pattern checks for one creator over a window.
 * @param {Array<{placed_at:string, pincode_hash:string|null, is_cod:boolean, state:string, reason:string|null}>} recent  last 30 days
 * @param {Array<{placed_at:string}>} last24h
 * @param {boolean} postedRecently  a Clockwork post in the last 48 hours
 */
export function fraudSignals({ recent, last24h, postedRecently, cfg }) {
  const signals = [];
  const dailyAvg = recent.length / 30;
  if (last24h.length >= 5 && dailyAvg > 0 && last24h.length > cfg.velocityMultiple * dailyAvg && !postedRecently) {
    signals.push({ code: 'velocity', message: 'A sudden spike of orders with no new Clockwork post' });
  }
  if (recent.length >= 10) {
    const counts = {};
    for (const o of recent) if (o.pincode_hash) counts[o.pincode_hash] = (counts[o.pincode_hash] || 0) + 1;
    const top = Math.max(0, ...Object.values(counts));
    if (top / recent.length > cfg.pincodeShareMax) signals.push({ code: 'pincode_cluster', message: 'Many orders going to one pincode or address' });
  }
  const cod = recent.filter((o) => o.is_cod);
  if (cod.length >= 10) {
    const cancelled = cod.filter((o) => o.state === 'reversed' && o.reason === 'cancelled').length;
    if (cancelled / cod.length > cfg.codCancelShareMax) signals.push({ code: 'cod_cancellations', message: 'A high share of cash-on-delivery orders cancelled' });
  }
  return signals;
}

/**
 * Rohan's repeat rule: of the customers a creator brought who should have run out by now,
 * at least `minRatio` must have reordered on the site. Only checked after enough customers are due.
 * @param {Array<{delivered_at:string, tubes:number, reordered:boolean}>} firstOrders  the creator's new-customer orders
 */
export function repeatCheck({ firstOrders, creatorSince, cfg, now = new Date() }) {
  const monthsActive = (now - new Date(creatorSince)) / (30 * DAY);
  if (monthsActive < cfg.startAfterMonths) return { applies: false, reason: 'too_early' };
  const due = firstOrders.filter((o) => o.delivered_at &&
    now - new Date(o.delivered_at) >= ((o.tubes || 1) * cfg.daysPerTube + cfg.graceDays) * DAY);
  if (due.length < cfg.minDueCustomers) return { applies: false, reason: 'not_enough_due', due: due.length };
  const reordered = due.filter((o) => o.reordered).length;
  const ratio = reordered / due.length;
  return { applies: true, due: due.length, reordered, ratio, pass: ratio >= cfg.minRatio };
}

export function financialYear(d = new Date()) {
  const ist = new Date(new Date(d).getTime() + 5.5 * 3600000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * TDS for this payout. Once the year's credited commission crosses the threshold, tax applies to the whole year,
 * so the shortfall on earlier payouts is collected now.
 * @param {number} creditedBeforePaise  commission credited earlier this FY
 * @param {number} tdsBeforePaise       TDS already deducted this FY
 * @param {number} grossNowPaise        commission credited in this payout
 */
export function tdsFor({ creditedBeforePaise, tdsBeforePaise, grossNowPaise, hasValidPan, cfg }) {
  const total = creditedBeforePaise + grossNowPaise;
  const rate = hasValidPan ? cfg.rateBps : cfg.noPanRateBps;
  if (hasValidPan && total <= cfg.annualThresholdPaise) return 0;
  const dueTotal = Math.ceil((total * rate) / 10000);
  return Math.max(0, dueTotal - tdsBeforePaise);
}

export function isValidPan(pan) {
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(pan || '').toUpperCase());
}
export function isValidIfsc(ifsc) {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(ifsc || '').toUpperCase());
}
export function isValidVpa(vpa) {
  return /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/.test(String(vpa || ''));
}
