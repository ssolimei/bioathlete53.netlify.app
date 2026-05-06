// netlify/functions/strava.js
// Live Strava sync: refresh access token + fetch last 30 activities, with 5-min cache.

let cache = { data: null, ts: 0 };
const CACHE_MS = 5 * 60 * 1000;

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: cors, body: '' };
    }

    const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
    const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
    const REFRESH_TOKEN = process.env.STRAVA_REFRESH_TOKEN;

    if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
      return {
        statusCode: 500,
        headers: cors,
        body: JSON.stringify({
          error: 'Missing env vars',
          have: {
            STRAVA_CLIENT_ID: !!CLIENT_ID,
            STRAVA_CLIENT_SECRET: !!CLIENT_SECRET,
            STRAVA_REFRESH_TOKEN: !!REFRESH_TOKEN
          },
          hint: 'Run /auth.html flow first, then save tokens in Netlify env.'
        })
      };
    }

    const now = Date.now();
    const force = event.queryStringParameters && event.queryStringParameters.force === '1';
    if (!force && cache.data && (now - cache.ts) < CACHE_MS) {
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({ ...cache.data, cached: true, cache_age_s: Math.floor((now - cache.ts) / 1000) })
      };
    }

    // Refresh access token
    const tokenRes = await fetch('https://www.strava.com/api/v3/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: REFRESH_TOKEN,
        grant_type: 'refresh_token'
      }).toString()
    });

    const tokenText = await tokenRes.text();
    let tokenData;
    try {
      tokenData = JSON.parse(tokenText);
    } catch (e) {
      return {
        statusCode: 502,
        headers: cors,
        body: JSON.stringify({ error: 'Token endpoint returned non-JSON', status: tokenRes.status, raw: tokenText.slice(0, 500) })
      };
    }

    if (!tokenRes.ok) {
      return {
        statusCode: tokenRes.status,
        headers: cors,
        body: JSON.stringify({ error: 'Token refresh failed', strava_response: tokenData })
      };
    }

    const accessToken = tokenData.access_token;

    // Fetch activities
    const actRes = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=30', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (actRes.status === 429) {
      return {
        statusCode: 429,
        headers: cors,
        body: JSON.stringify({ error: 'Strava rate limit reached. Try again in 15 min.' })
      };
    }

    const actText = await actRes.text();
    let activities;
    try {
      activities = JSON.parse(actText);
    } catch (e) {
      return {
        statusCode: 502,
        headers: cors,
        body: JSON.stringify({ error: 'Activities endpoint returned non-JSON', status: actRes.status, raw: actText.slice(0, 500) })
      };
    }

    if (!actRes.ok) {
      return {
        statusCode: actRes.status,
        headers: cors,
        body: JSON.stringify({ error: 'Activities fetch failed', strava_response: activities })
      };
    }

    const trimmed = activities.map(a => ({
      id: a.id,
      name: a.name,
      type: a.type,
      sport_type: a.sport_type,
      start_date_local: a.start_date_local,
      distance: a.distance,
      moving_time: a.moving_time,
      elapsed_time: a.elapsed_time,
      total_elevation_gain: a.total_elevation_gain,
      average_speed: a.average_speed,
      max_speed: a.max_speed,
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

    cache = { data: result, ts: now };

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({ ...result, cached: false })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({
        error: 'Function crashed',
        message: err.message,
        stack: err.stack ? err.stack.split('\n').slice(0, 5).join(' | ') : null
      })
    };
  }
};
