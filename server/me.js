// Revessent /api/me
// Verifies the caller's Supabase access token, matches the Supabase user id
// to Revessent's Neon users table, and returns the current user/org context.
//
// Auth verification (audit #66) comes from the shared helper — this file no
// longer carries its own inline copy. The user-resolution queries below are
// intentionally local: they join organizations (for organization_name) and
// keep me.js's 404-not-found semantics, which the shared authenticateRequest
// (401 + throw) does not provide.

const { Pool } = require('pg');
const { getBearerToken, verifySupabaseToken } = require('./_lib/supabase-auth');

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

async function findNeonUserBySupabaseId(client, supabaseUserId) {
  const result = await client.query(
    `select u.id, u.organization_id, u.email, u.role, u.supabase_user_id, o.name as organization_name
       from users u
       left join organizations o on o.id = u.organization_id
      where u.supabase_user_id = $1
      limit 1`,
    [supabaseUserId]
  );

  return result.rows[0] || null;
}

async function findNeonUserByEmail(client, email) {
  const result = await client.query(
    `select u.id, u.organization_id, u.email, u.role, u.supabase_user_id, o.name as organization_name
       from users u
       left join organizations o on o.id = u.organization_id
      where lower(u.email) = lower($1)
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

    if (!result.rows[0]) return user;
    return { ...user, supabase_user_id: result.rows[0].supabase_user_id };
  } catch (error) {
    if (error && error.code === '23505') {
      const boundUser = await findNeonUserBySupabaseId(client, supabaseUserId);
      if (boundUser && String(boundUser.id) === String(user.id)) return boundUser;
    }
    throw error;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let client;

  try {
    const token = getBearerToken(req);
    const { email, supabaseUserId } = await verifySupabaseToken(token);

    client = await pool.connect();
    let user = await findNeonUserBySupabaseId(client, supabaseUserId);

    if (!user) {
      user = await findNeonUserByEmail(client, email);

      if (user && user.supabase_user_id && user.supabase_user_id !== supabaseUserId) {
        return sendJson(res, 401, { error: 'Supabase account is already bound to a different Revessent user.' });
      }

      if (user) user = await backfillSupabaseUserId(client, user, supabaseUserId);
    }

    if (!user) {
      return sendJson(res, 404, { error: 'No Revessent user found for this Supabase account.' });
    }

    return sendJson(res, 200, {
      userId: user.id,
      organizationId: user.organization_id,
      organizationName: user.organization_name || '',
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
