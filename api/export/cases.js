// Revessent /api/export/cases
// Bulk CSV export of recovery cases for the authenticated user's organization.
// Query params: from, to (ISO dates — default last 90 days), status (optional
// whitelist filter, default all). Returns text/csv (not JSON).

const { Pool } = require('pg');

const SUPABASE_URL = 'https://zujmouzzqiovgbnanrvv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7JoawOBwMZ-ZIFmDrjkHSA_AdIWlCi3';
const DEFAULT_RANGE_DAYS = 90;
const CASE_STATUSES = new Set([
  'detected',
  'retrying',
  'awaiting_approval',
  'note_sent',
  'checkout_sent',
  'recovered',
  'lost',
  'canceled',
]);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function getQueryParam(req, key) {
  if (req.query && req.query[key] != null) return String(req.query[key]);

  try {
    const url = new URL(req.url, 'https://revessent.local');
    return url.searchParams.get(key) || '';
  } catch (_) {
    return '';
  }
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

function cleanString(value) {
  return value == null ? '' : String(value).trim();
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

function toIsoDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

// Amounts are written in the currency's major unit (cents / 100) as plain
// numbers — friendliest for spreadsheets, with Currency in its own column.
function toMajorUnits(value) {
  const cents = Number(value);
  if (!Number.isFinite(cents)) return '';
  const major = cents / 100;
  return String(Number.isInteger(major) ? major : major.toFixed(2));
}

function parseDateParam(value) {
  const text = cleanString(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
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

    // Date range: default last 90 days. `to` is inclusive of the whole day.
    const now = new Date();
    const from = parseDateParam(getQueryParam(req, 'from')) ||
      new Date(now.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
    const toParam = parseDateParam(getQueryParam(req, 'to'));
    const to = toParam ? new Date(toParam.getTime() + 24 * 60 * 60 * 1000) : now;

    // Optional status filter — whitelist against the enum so a bad value
    // can't blow up the query.
    const status = cleanString(getQueryParam(req, 'status'));
    if (status && !CASE_STATUSES.has(status)) {
      return sendJson(res, 400, { error: 'Unknown status filter.' });
    }

    const result = await client.query(
      `select
         rc.id,
         sm.name as member_name,
         sm.email as member_email,
         rc.amount_cents,
         rc.currency,
         rc.decline_code,
         rc.status,
         rc.retry_count,
         rc.failed_at,
         rc.recovered_at,
         rc.recovery_source
       from recovery_cases rc
       join stripe_members sm on sm.id = rc.member_id
      where rc.organization_id = $1
        and rc.failed_at >= $2
        and rc.failed_at < $3
        ${status ? 'and rc.status = $4' : ''}
      order by rc.failed_at desc nulls last
      limit 10000`,
      status ? [organizationId, from, to, status] : [organizationId, from, to]
    );

    const header = [
      'Case ID',
      'Member Name',
      'Member Email',
      'Amount',
      'Currency',
      'Decline Reason',
      'Status',
      'Retry Count',
      'Failed Date',
      'Recovered Date',
      'Recovered Via',
    ].join(',');

    const rows = result.rows.map((row) =>
      [
        csvEscape(row.id),
        csvEscape(row.member_name || ''),
        csvEscape(row.member_email || ''),
        csvEscape(toMajorUnits(row.amount_cents)),
        csvEscape(row.currency || ''),
        csvEscape(row.decline_code || ''),
        csvEscape(row.status || ''),
        csvEscape(row.retry_count == null ? 0 : row.retry_count),
        csvEscape(toIsoDate(row.failed_at)),
        csvEscape(toIsoDate(row.recovered_at)),
        csvEscape(row.recovery_source || ''),
      ].join(',')
    );

    const csv = [header, ...rows].join('\r\n');
    const dateLabel = new Date().toISOString().slice(0, 10);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="revessent-cases-${dateLabel}.csv"`);
    return res.end(csv);
  } catch (error) {
    if (error.statusCode && [400, 401, 403, 404].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }

    console.error('Revessent /api/export/cases failed:', error);
    return sendJson(res, 500, { error: 'Could not export recovery cases.' });
  } finally {
    if (client) client.release();
  }
};
