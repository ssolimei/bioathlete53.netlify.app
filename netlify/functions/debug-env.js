// netlify/functions/debug-env.js
// TEMPORARY DEBUG ENDPOINT — delete after diagnosing.
// Returns which Strava-related env vars are visible to the function runtime.

exports.handler = async () => {
  const keys = Object.keys(process.env)
    .filter(k => k.toUpperCase().includes('STRAVA'))
    .sort();

  const status = {};
  ['STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET', 'STRAVA_REFRESH_TOKEN'].forEach(k => {
    const v = process.env[k];
    status[k] = v ? `SET (length=${v.length})` : 'MISSING';
  });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      strava_keys_found: keys,
      status,
      total_env_vars: Object.keys(process.env).length,
      node_version: process.version
    }, null, 2)
  };
};
