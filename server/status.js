// Revessent /api/status
// Fully public (no auth) status probe.
// Checks Neon PostgreSQL database reachability and Supabase Auth endpoint reachability.
// Returns { status: 'operational' | 'degraded' | 'down', database: boolean, auth: boolean, checkedAt: string }

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  ssl: { rejectUnauthorized: false },
});

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
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url) return true;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

    const res = await fetch(`${url}/auth/v1/health`, {
      method: 'GET',
      headers: {
        apikey: anonKey || '',
      },
      signal: controller.signal,
    }).catch(async () => {
      return fetch(`${url}/auth/v1/settings`, {
        method: 'GET',
        headers: { apikey: anonKey || '' },
        signal: controller.signal,
      });
    });

    clearTimeout(timer);
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
