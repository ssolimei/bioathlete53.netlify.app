// netlify/functions/oura.js
// Proxy para Oura API v2 — evita CORS desde el browser
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method not allowed' };
  }

  try {
    const { pat, endpoint, params } = JSON.parse(event.body);
    if (!pat || !endpoint) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing pat or endpoint' }) };
    }

    const allowed = ['daily_sleep', 'daily_readiness', 'sleep', 'daily_spo2', 'daily_activity'];
    if (!allowed.includes(endpoint)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Endpoint not allowed' }) };
    }

    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    const url = `https://api.ouraring.com/v2/usercollection/${endpoint}${query}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${pat}` }
    });

    const data = await response.json();

    if (response.status === 401) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token invalido o revocado' }) };
    }

    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
