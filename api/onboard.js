// Revessent /api/onboard
// Idempotently creates or binds a Neon user for a Supabase account after
// client-side signup/signin. New rows are bound to Supabase's stable user id.

const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  if (Buffer.isBuffer(req.body)) {
    const raw = req.body.toString('utf8');
    return raw ? JSON.parse(raw) : {};
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function cleanString(value) {
  return value == null ? '' : String(value).trim();
}

function cleanEmail(value) {
  return cleanString(value).toLowerCase();
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function findUserBySupabaseId(client, supabaseUserId) {
  if (!supabaseUserId) return null;

  const result = await client.query(
    `select id, organization_id, email, role, supabase_user_id
       from users
      where supabase_user_id = $1
      limit 1`,
    [supabaseUserId]
  );

  return result.rows[0] || null;
}

async function findUserByEmail(client, email) {
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

  const result = await client.query(
    `update users
        set supabase_user_id = $1
      where id = $2
        and supabase_user_id is null
    returning id, organization_id, email, role, supabase_user_id`,
    [supabaseUserId, user.id]
  );

  return result.rows[0] || user;
}

async function createUserAndOrganization(client, email, supabaseUserId) {
  const organizationId = crypto.randomUUID();
  const userId = crypto.randomUUID();

  await client.query(
    `insert into organizations (id, name, created_at, updated_at)
     values ($1, $2, now(), now())`,
    [organizationId, 'New workspace']
  );

  const result = await client.query(
    `insert into users (id, organization_id, email, role, supabase_user_id, created_at, updated_at)
     values ($1, $2, $3, 'owner', $4, now(), now())
     returning id, organization_id, email, role, supabase_user_id`,
    [userId, organizationId, email, supabaseUserId || null]
  );

  return result.rows[0];
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (_) {
    return sendJson(res, 400, { error: 'Invalid JSON body.' });
  }

  const email = cleanEmail(body && body.email);
  const supabaseUserId = cleanString(body && body.supabaseUserId);

  if (!email || !isEmail(email)) return sendJson(res, 400, { error: 'A valid email is required.' });
  if (!supabaseUserId) return sendJson(res, 400, { error: 'supabaseUserId is required.' });

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    let user = await findUserBySupabaseId(client, supabaseUserId);

    if (!user) {
      user = await findUserByEmail(client, email);

      if (user && user.supabase_user_id && user.supabase_user_id !== supabaseUserId) {
        await client.query('ROLLBACK');
        return sendJson(res, 409, { error: 'This email is already bound to another Supabase account.' });
      }

      if (user) user = await backfillSupabaseUserId(client, user, supabaseUserId);
    }

    if (!user) user = await createUserAndOrganization(client, email, supabaseUserId);

    await client.query('COMMIT');

    return sendJson(res, 200, {
      ok: true,
      userId: user.id,
      organizationId: user.organization_id,
      email: user.email,
      role: user.role,
    });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Revessent /api/onboard rollback failed:', rollbackError);
      }
    }

    if (error && error.code === '23505') {
      return sendJson(res, 409, { error: 'This Supabase account is already bound to another user.' });
    }

    console.error('Revessent /api/onboard failed:', error);
    return sendJson(res, 500, { error: 'Could not sync account.' });
  } finally {
    if (client) client.release();
  }
};
