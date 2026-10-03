// Revessent /api/status
// Fully public (no auth) status probe.
// Checks Neon PostgreSQL database reachability and Supabase Auth endpoint reachability.
// Returns { status: 'operational' | 'degraded' | 'down', database: boolean, auth: boolean, checkedAt: string }

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1, // audit #45: single connection per serverless instance
  ssl: { rejectUnauthorized: false },
});

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zujmouzzqiovgbnanrvv.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_7JoawOBwMZ-ZIFmDrjkHSA_AdIWlCi3';
const CHECK_TIMEOUT_MS = 2500;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function checkDatabase() {
  let client;
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Database check timeout')), CHECK_TIMEOUT_MS)
    );
    const dbPromise = (async () => {
      client = await pool.connect();
      await client.query('SELECT 1');
      return true;
    })();

    await Promise.race([dbPromise, timeoutPromise]);
    return true;
  } catch (err) {
    console.error('Revessent /api/status database check error:', err && err.message);
    return false;
  } finally {
    if (client) client.release();
  }
}

async function checkAuth() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

    const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_ANON_KEY,
      },
      signal: controller.signal,
    }).catch(async () => {
      // Fallback check against root or settings if /health returns 404 or differs
      return fetch(`${SUPABASE_URL}/auth/v1/settings`, {
        method: 'GET',
        headers: { apikey: SUPABASE_ANON_KEY },
        signal: controller.signal,
      });
    });

    clearTimeout(timer);
    // If the server responded with any HTTP status (even 200, 401, or 404), the auth service is reachable
    return Boolean(res && (res.status >= 200 && res.status < 500));
  } catch (err) {
    console.error('Revessent /api/status auth check error:', err && err.message);
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  const [dbOk, authOk] = await Promise.all([checkDatabase(), checkAuth()]);

  let status = 'operational';
  if (dbOk && authOk) {
    status = 'operational';
  } else if (dbOk || authOk) {
    status = 'degraded';
  } else {
    status = 'down';
  }

  return sendJson(res, 200, {
    status,
    database: dbOk,
    auth: authOk,
    checkedAt: new Date().toISOString(),
  });
};
