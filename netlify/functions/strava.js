// netlify/functions/strava.js
// Live Strava sync with auto-refresh of access tokens + 5-min in-memory cache.
//
// How it works:
// 1. Reads STRAVA_REFRESH_TOKEN, STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET from Netlify env.
// 2. POSTs to /oauth/token with grant_type=refresh_token to get a fresh access_token.
//    (Strava rotates refresh tokens; we get a new one back, but for a single-user dashboard
//    the original refresh_token typically stays valid. If Strava ever rotates it and ours
//    becomes invalid, you'll need to re-auth via /auth.html.)
// 3. Calls /athlete/activities?per_page=30 to get the last 30 activities.
// 4. Caches the result in module-scope memory for 5 min. Subsequent loads within 5 min
//    return cached data without hitting Strava (rate-limit friendly).
//
// Note on Netlify Functions: each warm invocation reuses module scope, so cache works.
// Cold starts reset cache, which is fine — user just sees an extra ~500ms on first load.

let cache = { data: null, ts: 0 };
const CACHE_MS = 5 * 60 * 1000; // 5 minutes

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
  const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
  const REFRESH_TOKEN = process.env.STRAVA_REFRESH_TOKEN;

  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Missing env vars',
        required: ['STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET', 'STRAVA_REFRESH_TOKEN'],
        hint: 'Run /auth.html flow first, then save tokens in Netlify env.'
      })
    };
  }

  // Cache hit?
  const now = Date.now();
  const force = event.queryStringParameters && event.queryStringParameters.force === '1';
  if (!force && cache.data && (now - cache.ts) < CACHE_MS) {
    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...cache.data, cached: true, cache_age_s: Math.floor((now - cache.ts) / 1000) })
    };
  }

  try {
    // Step 1: refresh access token
    const tokenRes = await fetch('https://www.strava.com/api/v3/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: REFRESH_TOKEN,
        grant_type: 'refresh_token'
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      return {
        statusCode: tokenRes.status,
        headers,
        body: JSON.stringify({ error: 'Token refresh failed', details: tokenData })
      };
    }

    const accessToken = tokenData.access_token;

    // Step 2: fetch last 30 activities (all types — running, walking, cycling, gym, swim, etc.)
    const actRes = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=30', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (actRes.status === 429) {
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({ error: 'Strava rate limit reached. Try again in 15 min.' })
      };
    }

    const activities = await actRes.json();
    if (!actRes.ok) {
      return {
        statusCode: actRes.status,
        headers,
        body: JSON.stringify({ error: 'Activities fetch failed', details: activities })
      };
    }

    // Trim to essential fields (keeps payload small, no PII bloat)
    const trimmed = activities.map(a => ({
      id: a.id,
      name: a.name,
      type: a.type,
      sport_type: a.sport_type,
      start_date_local: a.start_date_local,
      distance: a.distance,                    // meters
      moving_time: a.moving_time,              // seconds
      elapsed_time: a.elapsed_time,            // seconds
      total_elevation_gain: a.total_elevation_gain, // meters
      average_speed: a.average_speed,          // m/s
      max_speed: a.max_speed,                  // m/s
      average_heartrate: a.average_heartrate,
      max_heartrate: a.max_heartrate,
      kilojoules: a.kilojoules,
      suffer_score: a.suffer_score,
      kudos_count: a.kudos_count
    }));

    const result = {
      synced_at: new Date().toISOString(),
      count: trimmed.length,
      activities: trimmed
    };

    // Update cache
    cache = { data: result, ts: now };

    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...result, cached: false })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
