// Revessent /api/export/members
// Bulk CSV export of stripe_members (with subscription status and lifetime
// recovered amount from recovery_attributions) for the authenticated user's
// organization. Returns text/csv (not JSON).

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

// Standard CSV escaping: wrap in double quotes when the value contains a
// comma, double quote, or newline; escape internal double quotes by doubling
// them. Never skip this — member names/emails can contain commas or quotes.
function csvEscape(value) {
  if (value == null) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

// Amounts are written in the currency's major unit (cents / 100) as plain
// numbers — friendliest for spreadsheets.
function toMajorUnits(value) {
  if (value == null) return '';
  const cents = Number(value);
  if (!Number.isFinite(cents)) return '';
  const major = cents / 100;
  return String(Number.isInteger(major) ? major : major.toFixed(2));
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
    const organizationId = user.organization_id;

    const result = await client.query(
      `select
         sm.name,
         sm.email,
         ss.status as sub_status,
         ss.amount_cents as sub_amount_cents,
         recovered.total_cents as lifetime_recovered_cents
       from stripe_members sm
       left join stripe_subscriptions ss on ss.member_id = sm.id
       left join (
         select member_id, sum(amount_cents) as total_cents
           from recovery_attributions
          where organization_id = $1
          group by member_id
       ) recovered on recovered.member_id = sm.id
      where sm.organization_id = $1
      order by sm.created_at desc nulls last
      limit 10000`,
      [organizationId]
    );

    const header = [
      'Member Name',
      'Email',
      'Subscription Status',
      'Subscription Amount',
      'Lifetime Recovered',
    ].join(',');

    const rows = result.rows.map((row) =>
      [
        csvEscape(row.name || ''),
        csvEscape(row.email || ''),
        csvEscape(row.sub_status || ''),
        csvEscape(toMajorUnits(row.sub_amount_cents)),
        csvEscape(toMajorUnits(row.lifetime_recovered_cents)),
      ].join(',')
    );

    const csv = [header, ...rows].join('\r\n');
    const dateLabel = new Date().toISOString().slice(0, 10);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="revessent-members-${dateLabel}.csv"`);
    return res.end(csv);
  } catch (error) {
    if (error.statusCode && [400, 401, 403, 404].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }

    console.error('Revessent /api/export/members failed:', error);
    return sendJson(res, 500, { error: 'Could not export members.' });
  } finally {
    if (client) client.release();
  }
};
