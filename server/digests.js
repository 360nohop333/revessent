// Revessent /api/digests
// Lists weekly forensics digests for the authenticated organization.

const { Pool } = require('pg');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zujmouzzqiovgbnanrvv.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_7JoawOBwMZ-ZIFmDrjkHSA_AdIWlCi3';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1, // audit #45: single connection per serverless instance
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
  const supabaseUserId = (supabaseUser && supabaseUser.id ? String(supabaseUser.id) : '').trim();
  const email = (supabaseUser && supabaseUser.email ? String(supabaseUser.email) : '').trim().toLowerCase();

  if (!supabaseUserId) {
    const error = new Error('Supabase user id is missing.');
    error.statusCode = 401;
    throw error;
  }

  if (!email) {
    const error = new Error('Supabase user has no email address.');
    error.statusCode = 401;
    throw error;
  }

  return { email, supabaseUserId };
}

async function findNeonUserBySupabaseId(client, supabaseUserId) {
  const result = await client.query(
    `select id, organization_id, email, role, supabase_user_id
       from users
      where supabase_user_id = $1
      limit 1`,
    [supabaseUserId]
  );

  return result.rows[0] || null;
}

async function findNeonUserByEmail(client, email) {
  const result = await client.query(
    `select id, organization_id, email, role, supabase_user_id
       from users
      where lower(email) = lower($1)
      limit 1`,
    [email]
  );

  return result.rows[0] || null;
}

async function backfillSupabaseUserId(client, user, supabaseUserId) {
  if (!user || !supabaseUserId || user.supabase_user_id) return user;

  try {
    const result = await client.query(
      `update users
          set supabase_user_id = $1
        where id = $2
          and supabase_user_id is null
      returning id, organization_id, email, role, supabase_user_id`,
      [supabaseUserId, user.id]
    );

    return result.rows[0] || user;
  } catch (error) {
    if (error && error.code === '23505') {
      const boundUser = await findNeonUserBySupabaseId(client, supabaseUserId);
      if (boundUser && String(boundUser.id) === String(user.id)) return boundUser;
    }
    throw error;
  }
}

async function authenticateRequest(req, client) {
  const token = getBearerToken(req);
  const { email, supabaseUserId } = await verifySupabaseToken(token);
  let user = await findNeonUserBySupabaseId(client, supabaseUserId);

  if (!user) {
    user = await findNeonUserByEmail(client, email);

    if (user && user.supabase_user_id && user.supabase_user_id !== supabaseUserId) {
      const error = new Error('Supabase account is already bound to a different Revessent user.');
      error.statusCode = 401;
      throw error;
    }

    if (user) user = await backfillSupabaseUserId(client, user, supabaseUserId);
  }

  if (!user) {
    const error = new Error('No Revessent user found for this Supabase account.');
    error.statusCode = 401;
    throw error;
  }

  return { token, email, supabaseUserId, user };
}

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function toInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let client;

  try {
    client = await pool.connect();
    const { user } = await authenticateRequest(req, client);

    const result = await client.query(
      `select *
         from forensics_digests
        where organization_id = $1
        order by week_start_date desc
        limit 20`,
      [user.organization_id]
    );

    return sendJson(res, 200, {
      digests: result.rows.map((row) => ({
        id: row.id,
        weekStartDate: toIso(row.week_start_date),
        weekEndDate: toIso(row.week_end_date),
        totalFailed: toInt(row.total_failed),
        totalRecovered: toInt(row.total_recovered),
        totalLost: toInt(row.total_lost),
        recoveredAmountCents: toInt(row.recovered_amount_cents),
        lostAmountCents: toInt(row.lost_amount_cents),
        aiNarrativeParagraph: row.ai_narrative_paragraph || '',
        sentAt: toIso(row.sent_at),
      })),
    });
  } catch (error) {
    if (error.statusCode && [400, 401, 403].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }

    console.error('Revessent /api/digests failed:', error);
    return sendJson(res, 500, { error: 'Could not load weekly digests.' });
  } finally {
    if (client) client.release();
  }
};

