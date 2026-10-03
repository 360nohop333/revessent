// Revessent /api/referrals
// Returns the authenticated organization's referral code, shareable invite
// link, and the list of organizations that signed up using their code.

const { Pool } = require('pg');
const crypto = require('crypto');
const { authenticateRequest } = require('./_lib/supabase-auth');
const DEFAULT_APP_BASE_URL = 'https://revessent-alpha.vercel.app';
const REFERRAL_CODE_LENGTH = 6;
const REFERRAL_CODE_RETRIES = 5;
// Unambiguous alphabet (no I/L/O/0/1) so codes survive being read aloud.
const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

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
