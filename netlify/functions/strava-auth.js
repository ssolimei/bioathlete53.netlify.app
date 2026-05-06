// netlify/functions/strava-auth.js
// One-time OAuth handler: exchanges authorization code for refresh_token.

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Wrap everything in a top-level try/catch so any error returns JSON, not a 500 HTML page
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: cors, body: '' };
    }
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: cors,
        body: JSON.stringify({ error: 'Method not allowed', method: event.httpMethod })
      };
    }

    const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
    const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

    if (!CLIENT_ID || !CLIENT_SECRET) {
      return {
        statusCode: 500,
        headers: cors,
        body: JSON.stringify({
          error: 'Missing env vars',
          required: ['STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET'],
          have_client_id: !!CLIENT_ID,
          have_client_secret: !!CLIENT_SECRET
        })
      };
    }

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({ error: 'Invalid JSON body', detail: e.message })
      };
    }

    const code = body.code;
    if (!code) {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({ error: 'Missing code parameter' })
      };
    }

    // Use global fetch (available on Node 18+, Netlify uses Node 22)
    const response = await fetch('https://www.strava.com/api/v3/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code'
      }).toString()
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return {
        statusCode: 502,
        headers: cors,
        body: JSON.stringify({
          error: 'Strava returned non-JSON',
          status: response.status,
          raw: text.slice(0, 500)
        })
      };
    }

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: cors,
        body: JSON.stringify({
          error: 'Strava token exchange failed',
          strava_status: response.status,
          strava_response: data
        })
      };
    }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        athlete: data.athlete ? { id: data.athlete.id, firstname: data.athlete.firstname } : null,
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at,
        message: 'Save refresh_token in Netlify env as STRAVA_REFRESH_TOKEN'
      })
    };
  } catch (err) {
    // Any unhandled error — return JSON not HTML
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
