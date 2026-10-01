// Revessent /api/referrals
// Returns the authenticated organization's referral code, shareable invite
// link, and the list of organizations that signed up using their code.

const { Pool } = require('pg');
const crypto = require('crypto');

const SUPABASE_URL = 'https://zujmouzzqiovgbnanrvv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7JoawOBwMZ-ZIFmDrjkHSA_AdIWlCi3';
const DEFAULT_APP_BASE_URL = 'https://revessent-alpha.vercel.app';
const REFERRAL_CODE_LENGTH = 6;
const REFERRAL_CODE_RETRIES = 5;
// Unambiguous alphabet (no I/L/O/0/1) so codes survive being read aloud.
const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

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

function cleanString(value) {
  return value == null ? '' : String(value).trim();
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function generateReferralCodeCandidate() {
  const bytes = crypto.randomBytes(REFERRAL_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) {
    code += REFERRAL_CODE_ALPHABET[bytes[i] % REFERRAL_CODE_ALPHABET.length];
  }
  return code;
}

// Same base-URL resolution as api/razorpay/connect.js's webhookBaseUrl().
function appBaseUrl() {
  return cleanString(process.env.PUBLIC_APP_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || DEFAULT_APP_BASE_URL)
    .replace(/\/$/, '')
    .replace(/^([^h])/, 'https://$1');
}

// Return the org's referral code, lazily generating one for orgs created
// before the referral feature existed.
async function ensureReferralCode(client, organizationId) {
  const existing = await client.query(
    `select referral_code
       from organizations
      where id = $1
      limit 1`,
    [organizationId]
  );

  const current = existing.rows[0] ? existing.rows[0].referral_code : null;
  if (current) return current;

  for (let attempt = 0; attempt < REFERRAL_CODE_RETRIES; attempt += 1) {
    const code = generateReferralCodeCandidate();

    try {
      const updated = await client.query(
        `update organizations
            set referral_code = $2
          where id = $1
            and referral_code is null
          returning referral_code`,
        [organizationId, code]
      );

      if (updated.rows[0]) return updated.rows[0].referral_code;
    } catch (error) {
      // Collision with another org's code (unique index) — try another.
      if (error && error.code === '23505') continue;
      throw error;
    }
  }

  return null;
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

    const referralCode = await ensureReferralCode(client, organizationId);

    const referralsResult = await client.query(
      `select o.name as organization_name, r.signed_up_at
         from referrals r
         join organizations o on o.id = r.referred_organization_id
        where r.referrer_organization_id = $1
          and r.signed_up_at is not null
        order by r.signed_up_at desc nulls last`,
      [organizationId]
    );

    // Only expose the referred organization's NAME — nothing more sensitive.
    const referrals = referralsResult.rows.map((row) => ({
      organizationName: row.organization_name || 'A workspace',
      signedUpAt: toIso(row.signed_up_at),
    }));

    return sendJson(res, 200, {
      referralCode: referralCode || '',
      referralLink: referralCode ? `${appBaseUrl()}/login.html?ref=${encodeURIComponent(referralCode)}` : '',
      referredCount: referrals.length,
      referrals,
    });
  } catch (error) {
    if (error.statusCode && [400, 401, 403, 404].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }

    console.error('Revessent /api/referrals failed:', error);
    return sendJson(res, 500, { error: 'Could not load referral information.' });
  } finally {
    if (client) client.release();
  }
};
