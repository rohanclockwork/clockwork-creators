// Instagram API: OAuth and the numbers the qualification check needs.
// Endpoints follow Meta's Instagram API with Instagram login. Meta's dashboard says new apps use
// "Unified login"; if the login configuration issues a different authorize URL, set META_AUTHORIZE_URL.
// Test with Rohan's own Instagram account first (works before App Review).

import { config } from '../config.js';

const m = config.meta;
const graph = (path) => `${m.graphBase}/${m.graphVersion}${path}`;

async function getJson(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`Instagram API: ${JSON.stringify(json.error || json)}`);
  return json;
}

export function authorizeUrl(state) {
  const u = new URL(m.authorizeUrl);
  u.searchParams.set('client_id', m.appId);
  u.searchParams.set('redirect_uri', `${config.baseUrl}/auth/instagram/callback`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', m.scopes);
  u.searchParams.set('state', state);
  if (m.loginConfigId) u.searchParams.set('config_id', m.loginConfigId);
  return u.toString();
}

/** Exchange the code for a long-lived token (about 60 days). */
export async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: m.appId,
    client_secret: m.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: `${config.baseUrl}/auth/instagram/callback`,
    code,
  });
  const res = await fetch(m.tokenUrl, { method: 'POST', body });
  const short = await res.json();
  if (!res.ok || !short.access_token) throw new Error(`Instagram token exchange failed: ${JSON.stringify(short)}`);
  const long = await getJson(`${m.graphBase}/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(m.appSecret)}&access_token=${encodeURIComponent(short.access_token)}`);
  return { token: long.access_token, expiresAt: new Date(Date.now() + (long.expires_in || 5184000) * 1000) };
}

export async function refreshToken(token) {
  const r = await getJson(`${m.graphBase}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
  return { token: r.access_token, expiresAt: new Date(Date.now() + (r.expires_in || 5184000) * 1000) };
}

/** Everything qualify() needs, plus recent posts for the disclosure check. */
export async function fetchAccount(token) {
  const t = `access_token=${encodeURIComponent(token)}`;
  const me = await getJson(graph(`/me?fields=user_id,username,account_type,followers_count,media_count,biography&${t}`));

  const media = await getJson(graph(`/me/media?fields=id,media_type,media_product_type,timestamp,caption,permalink&limit=50&${t}`));
  const items = media.data || [];
  const reels = items.filter((x) => x.media_product_type === 'REELS');

  const withViews = [];
  for (const r of reels.slice(0, 15)) {
    let views = 0;
    try {
      const ins = await getJson(graph(`/${r.id}/insights?metric=views&${t}`));
      views = ins.data?.[0]?.values?.[0]?.value ?? ins.data?.[0]?.total_value?.value ?? 0;
    } catch { /* a reel without insights counts as zero views */ }
    withViews.push({ id: r.id, views, timestamp: r.timestamp, caption: r.caption || '', permalink: r.permalink });
  }

  let countryCounts = {};
  try {
    const demo = await getJson(graph(`/me/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=country&${t}`));
    for (const b of demo.data?.[0]?.total_value?.breakdowns?.[0]?.results || []) countryCounts[b.dimension_values[0]] = b.value;
  } catch { countryCounts = {}; }

  let followerSeries = [];
  try {
    const since = Math.floor(Date.now() / 1000) - 30 * 86400;
    const fc = await getJson(graph(`/me/insights?metric=follower_count&period=day&since=${since}&${t}`));
    // follower_count is daily net change; rebuild a series ending at today's total.
    const deltas = (fc.data?.[0]?.values || []).map((v) => v.value || 0);
    let total = me.followers_count;
    const series = [total];
    for (let i = deltas.length - 1; i >= 0; i--) { total -= deltas[i]; series.unshift(total); }
    followerSeries = series;
  } catch { followerSeries = []; }

  return {
    igUserId: String(me.user_id || me.id),
    username: me.username,
    accountType: me.account_type,
    biography: me.biography || '',
    followers: me.followers_count || 0,
    reels: withViews,
    posts: items.map((x) => ({ id: x.id, caption: x.caption || '', timestamp: x.timestamp, permalink: x.permalink })),
    countryCounts,
    followerSeries,
  };
}
