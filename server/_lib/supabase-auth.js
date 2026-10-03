// Revessent shared auth (audit #66).
// ONE unified module for JWT and token verification.
//
// Two verification modes:
//  - LOCAL (preferred): with SUPABASE_JWT_SECRET set (Supabase → Settings →
//    API → JWT Secret), the access token's HS256 signature is verified
//    in-process — no network call to Supabase per request. Claims checked:
//    signature, exp, iss, aud.
//  - REMOTE (fallback): the userinfo endpoint call when SUPABASE_URL and
//    SUPABASE_ANON_KEY are configured in the environment.
//
// After verification the Neon user is resolved by supabase_user_id, with the
// same email-link + backfill behavior.

const crypto = require('crypto');

const DEFAULT_PILOT_URL = 'https://zujmouzzqiovgbnanrvv.supabase.co';
const DEFAULT_PILOT_ANON_KEY = 'sb_publishable_7JoawOBwMZ-ZIFmDrjkHSA_AdIWlCi3';

const SUPABASE_URL = process.env.SUPABASE_URL || DEFAULT_PILOT_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || DEFAULT_PILOT_ANON_KEY;

// 2nd-opinion #20: fail loudly in production if falling back to pilot project
if (process.env.VERCEL_ENV === 'production' && (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY)) {
  console.error('[revessent] SUPABASE_URL / SUPABASE_ANON_KEY are not set — auth is falling back to HARD-CODED defaults from the pilot project. Set them in Vercel project env vars.');
}

function getBearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function b64urlToJson(part) {
  const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json);
}

// Verify the Supabase access token locally (HS256).
function verifyJwtLocally(token) {
  const secret = String(process.env.SUPABASE_JWT_SECRET || '').trim();
  if (!secret) return null; // not configured → caller falls back to remote

  const parts = String(token).split('.');
  if (parts.length !== 3) {
    const error = new Error('Invalid authorization token.');
    error.statusCode = 401;
    throw error;
  }

  let payload;
  try {
    const expected = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest();
    const given = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      throw new Error('bad signature');
    }
    payload = b64urlToJson(parts[1]);
  } catch (_) {
    const error = new Error('Invalid authorization token.');
    error.statusCode = 401;
    throw error;
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload || typeof payload.exp !== 'number' || payload.exp < now) {
    const error = new Error('Invalid or expired authorization token.');
    error.statusCode = 401;
    throw error;
  }

  const activeUrl = process.env.SUPABASE_URL || SUPABASE_URL;
  const activeAnonKey = process.env.SUPABASE_ANON_KEY || SUPABASE_ANON_KEY;

  if (activeUrl && payload.iss && payload.iss !== `${activeUrl}/auth/v1`) {
    const error = new Error('Invalid token issuer.');
    error.statusCode = 401;
    throw error;
  }
  if (payload.aud && payload.aud !== 'authenticated' && (!activeAnonKey || String(payload.aud) !== String(activeAnonKey))) {
    const error = new Error('Invalid token audience.');
    error.statusCode = 401;
    throw error;
  }

  const supabaseUserId = (payload.sub ? String(payload.sub) : '').trim();
  if (!supabaseUserId) {
    const error = new Error('Supabase user id is missing.');
    error.statusCode = 401;
    throw error;
  }

  const emailConfirmedAt = payload.email_confirmed_at || payload.confirmed_at || null;

  return { supabaseUserId, email: String(payload.email || '').trim().toLowerCase(), emailConfirmedAt };
}

async function verifySupabaseToken(token) {
  if (!token) {
    const error = new Error('Missing authorization token.');
    error.statusCode = 401;
    throw error;
  }

  const local = verifyJwtLocally(token);
  if (local) return local;

  const url = process.env.SUPABASE_URL || SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    const error = new Error('Supabase authentication is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.');
    error.statusCode = 500;
    throw error;
  }

  const response = await fetch(`${url}/auth/v1/user`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
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
  const emailConfirmedAt = supabaseUser && (supabaseUser.email_confirmed_at || supabaseUser.confirmed_at) ? (supabaseUser.email_confirmed_at || supabaseUser.confirmed_at) : null;

  if (!supabaseUserId) {
    const error = new Error('Supabase user id is missing.');
    error.statusCode = 401;
    throw error;
  }

  return { email, supabaseUserId, emailConfirmedAt };
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
  const result = await client.query(
    `update users
        set supabase_user_id = $1
      where id = $2
      returning id, organization_id, email, role, supabase_user_id`,
    [supabaseUserId, user.id]
  );
  return result.rows[0] || user;
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

module.exports = {
  getBearerToken,
  verifySupabaseToken,
  findNeonUserBySupabaseId,
  findNeonUserByEmail,
  backfillSupabaseUserId,
  authenticateRequest,
};
