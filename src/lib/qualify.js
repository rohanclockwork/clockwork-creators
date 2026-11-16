// Decides whether an Instagram account qualifies. Pure function: give it the numbers, get a decision.

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * @param {object} ig
 * @param {string} ig.username
 * @param {string} [ig.biography]
 * @param {number} ig.followers
 * @param {Array<{views:number, timestamp:string}>} ig.reels  most recent first
 * @param {Record<string, number>} ig.countryCounts  follower counts by ISO country code
 * @param {Array<number>} [ig.followerSeries]  daily follower counts, oldest first, up to 30 days
 * @param {object} rules  config.qualification
 * @param {Date} [now]
 */
export function qualify(ig, rules, now = new Date()) {
  const reasons = [];
  const metrics = {};

  metrics.followers = ig.followers ?? 0;
  if (metrics.followers < rules.minFollowers) reasons.push({ code: 'followers', message: `Fewer than ${rules.minFollowers.toLocaleString('en-IN')} followers` });

  const totalCountry = Object.values(ig.countryCounts || {}).reduce((a, b) => a + b, 0);
  metrics.indiaShare = totalCountry ? (ig.countryCounts.IN || 0) / totalCountry : 0;
  if (metrics.indiaShare < rules.minIndiaShare) reasons.push({ code: 'india_audience', message: `Less than ${Math.round(rules.minIndiaShare * 100)}% of your audience is in India` });

  const reels = ig.reels || [];
  metrics.reelCount = reels.length;
  const last10 = reels.slice(0, 10).map((r) => r.views || 0);
  metrics.medianViews = median(last10);
  metrics.medianViewRatio = metrics.followers ? metrics.medianViews / metrics.followers : 0;
  if (reels.length < rules.minReels) reasons.push({ code: 'activity', message: `Fewer than ${rules.minReels} reels` });
  const latest = reels[0]?.timestamp ? new Date(reels[0].timestamp) : null;
  metrics.daysSinceLastReel = latest ? Math.floor((now - latest) / 86400000) : null;
  if (!latest || metrics.daysSinceLastReel > rules.maxDaysSinceLastReel) reasons.push({ code: 'activity', message: `No reel in the last ${rules.maxDaysSinceLastReel} days` });
  if (metrics.medianViewRatio < rules.minMedianViewRatio) reasons.push({ code: 'reach', message: 'Recent reels reach too few people for your follower count' });

  const series = ig.followerSeries || [];
  let maxJump = 0;
  for (let i = 7; i < series.length; i++) {
    const before = series[i - 7];
    if (before > 0) maxJump = Math.max(maxJump, (series[i] - before) / before);
  }
  metrics.maxFollowerJump7d = maxJump;
  if (maxJump > rules.maxFollowerJump7d) reasons.push({ code: 'follower_spike', message: 'A sudden jump in followers in the last 30 days' });

  const text = `${ig.username || ''} ${ig.biography || ''}`.toLowerCase();
  const hit = rules.blockedKeywords.find((k) => text.includes(k));
  if (hit) reasons.push({ code: 'deals_account', message: 'Deals, coupon and cashback accounts are not eligible' });

  const qualified = reasons.length === 0;
  const level = qualified && metrics.medianViews >= rules.spotlightMedianViews ? 'spotlight' : 'creator';
  return { qualified, level, reasons, metrics };
}
