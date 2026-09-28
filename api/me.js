// Revessent /api/me
// Verifies the caller's Supabase access token, matches the Supabase email
// to Revessent's Neon users table, and returns the current user/org context.

const { Pool } = require('pg');

const SUPABASE_URL = 'https://zujmouzzqiovgbnanrvv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7JoawOBwMZ-ZIFmDrjkHSA_AdIWlCi3';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function getBearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function verifySupabaseToken(token) {
  if (!token) {
    const error = new Error('Missing authorization token.');
    error.statusCode = 401;
    throw error;
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
    },
  });

  if (!response.ok) {
    const error = new Error('Invalid or expired authorization token.');
    error.statusCode = 401;
    throw error;
  }

  const supabaseUser = await response.json();
  const email = (supabaseUser && supabaseUser.email ? String(supabaseUser.email) : '').trim().toLowerCase();

  if (!email) {
    const error = new Error('Supabase user has no email address.');
    error.statusCode = 401;
    throw error;
  }

  return { email };
}

async function findNeonUserByEmail(client, email) {
  const result = await client.query(
    `select id, organization_id, email, role
       from users
      where lower(email) = lower($1)
      limit 1`,
    [email]
  );

  return result.rows[0] || null;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let client;

  try {
    const token = getBearerToken(req);
    const { email } = await verifySupabaseToken(token);

    client = await pool.connect();
    const user = await findNeonUserByEmail(client, email);

    if (!user) {
      return sendJson(res, 404, { error: 'No Revessent user found for this Supabase account.' });
    }

    return sendJson(res, 200, {
      userId: user.id,
      organizationId: user.organization_id,
      email: user.email,
      role: user.role,
    });
  } catch (error) {
    if (error.statusCode === 401) {
      return sendJson(res, 401, { error: error.message || 'Unauthorized.' });
    }

    console.error('Revessent /api/me failed:', error);
    return sendJson(res, 500, { error: 'Could not load account context.' });
  } finally {
    if (client) client.release();
  }
};
