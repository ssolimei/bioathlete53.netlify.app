// netlify/functions/oura.js
// Live Oura sync: fetches last 30 days of sleep data (stages, score, HRV, RHR)
// PAT lives in env var OURA_PAT (Personal Access Token from cloud.ouraring.com).
// Cache: 30 min (Oura data updates once a day after wake).

let cache = { data: null, ts: 0 };
const CACHE_MS = 30 * 60 * 1000; // 30 min

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

    const PAT = process.env.OURA_PAT;
    if (!PAT) {
      return {
        statusCode: 500,
        headers: cors,
        body: JSON.stringify({
          error: 'Missing env var',
          required: ['OURA_PAT'],
          hint: 'Get a Personal Access Token from cloud.ouraring.com/personal-access-tokens and save as OURA_PAT in Netlify env.'
        })
      };
    }

    // Cache check
    const now = Date.now();
    const force = event.queryStringParameters && event.queryStringParameters.force === '1';
    if (!force && cache.data && (now - cache.ts) < CACHE_MS) {
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({ ...cache.data, cached: true, cache_age_s: Math.floor((now - cache.ts) / 1000) })
      };
    }

    // Date range: last 30 days
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 30);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const startDate = fmt(start);
    const endDate = fmt(end);

    // Fetch in parallel: detailed sleep periods (stages, HRV, HR) + daily sleep score
    const sleepPromise = fetchOura(`sleep?start_date=${startDate}&end_date=${endDate}`, PAT);
    const dailySleepPromise = fetchOura(`daily_sleep?start_date=${startDate}&end_date=${endDate}`, PAT);

    const [sleepResult, dailySleepResult] = await Promise.all([sleepPromise, dailySleepPromise]);

    if (sleepResult.error) return errorResponse(cors, sleepResult);
    if (dailySleepResult.error) return errorResponse(cors, dailySleepResult);

    // Build a daily score map from daily_sleep
    const scoreMap = {};
    (dailySleepResult.data.data || []).forEach(d => {
      scoreMap[d.day] = {
        score: d.score,
        contributors: d.contributors
      };
    });

    // Process sleep periods — pick the longest sleep per day (filter naps)
    const byDay = {};
    (sleepResult.data.data || []).forEach(s => {
      // s.type: 'long_sleep' | 'sleep' | 'late_nap' | 'rest'
      if (s.type !== 'long_sleep' && s.type !== 'sleep') return;

      const day = s.day;
      const duration = s.total_sleep_duration || 0;
      if (!byDay[day] || duration > (byDay[day].total_sleep_duration || 0)) {
        byDay[day] = s;
      }
    });

    // Build trimmed array sorted by day desc
    const days = Object.keys(byDay).sort((a, b) => b.localeCompare(a));

    const nights = days.map(day => {
      const s = byDay[day];
      const score = scoreMap[day];
      return {
        day,
        bedtime_start: s.bedtime_start,
        bedtime_end: s.bedtime_end,
        time_in_bed: s.time_in_bed,                    // seconds
        total_sleep_duration: s.total_sleep_duration,  // seconds
        deep_sleep_duration: s.deep_sleep_duration,    // seconds
        light_sleep_duration: s.light_sleep_duration,  // seconds
        rem_sleep_duration: s.rem_sleep_duration,      // seconds
        awake_time: s.awake_time,                      // seconds
        latency: s.latency,                            // seconds (sleep onset)
        efficiency: s.efficiency,                      // 0-100
        average_heart_rate: s.average_heart_rate,
        lowest_heart_rate: s.lowest_heart_rate,
        average_hrv: s.average_hrv,                    // ms (rmssd)
        average_breath: s.average_breath,
        restless_periods: s.restless_periods,
        sleep_score: score ? score.score : null,
        score_contributors: score ? score.contributors : null
      };
    });

    // Aggregates over the window (30 days)
    const aggregate = (key) => {
      const vals = nights.map(n => n[key]).filter(v => v != null);
      if (!vals.length) return null;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };

    const stats = {
      window_days: 30,
      nights_logged: nights.length,
      avg_sleep_score: Math.round(aggregate('sleep_score') || 0),
      avg_total_sleep_h: +(aggregate('total_sleep_duration') / 3600).toFixed(2),
      avg_time_in_bed_h: +(aggregate('time_in_bed') / 3600).toFixed(2),
      avg_deep_h: +(aggregate('deep_sleep_duration') / 3600).toFixed(2),
      avg_rem_h: +(aggregate('rem_sleep_duration') / 3600).toFixed(2),
      avg_light_h: +(aggregate('light_sleep_duration') / 3600).toFixed(2),
      avg_awake_h: +(aggregate('awake_time') / 3600).toFixed(2),
      avg_efficiency: Math.round(aggregate('efficiency') || 0),
      avg_hrv_ms: Math.round(aggregate('average_hrv') || 0),
      avg_resting_hr: Math.round(aggregate('lowest_heart_rate') || 0),
      avg_breath: +(aggregate('average_breath') || 0).toFixed(1)
    };

    const result = {
      synced_at: new Date().toISOString(),
      window: { start: startDate, end: endDate },
      stats,
      nights
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

async function fetchOura(endpoint, pat) {
  const url = `https://api.ouraring.com/v2/usercollection/${endpoint}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${pat}` } });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { error: 'Oura returned non-JSON', status: res.status, raw: text.slice(0, 500) };
    }
    if (!res.ok) {
      return { error: 'Oura request failed', status: res.status, oura_response: data, endpoint };
    }
    return { data };
  } catch (e) {
    return { error: 'Oura fetch threw', message: e.message, endpoint };
  }
}

function errorResponse(cors, err) {
  return {
    statusCode: err.status || 500,
    headers: cors,
    body: JSON.stringify(err)
  };
}
