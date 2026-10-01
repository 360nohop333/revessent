// Revessent /api/onboard
// Idempotently creates or binds a Neon user for a Supabase account after
// client-side signup/signin. New rows are bound to Supabase's stable user id.
//
// Referral system: every NEW organization gets a unique referral_code
// (6 random alphanumeric chars, collision-checked). If the signup request
// includes a valid `ref` code (captured by login.html from ?ref=CODE), the
// new org is recorded in the referrals table as a successful referral.

const { Pool } = require('pg');
const crypto = require('crypto');

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

function generateReferralCodeCandidate() {
  const bytes = crypto.randomBytes(REFERRAL_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) {
    code += REFERRAL_CODE_ALPHABET[bytes[i] % REFERRAL_CODE_ALPHABET.length];
  }
  return code;
}

// 6 random alphanumeric chars, checked against existing orgs and regenerated
// on collision — simple loop with a reasonable retry cap.
async function generateUniqueReferralCode(client) {
  for (let attempt = 0; attempt < REFERRAL_CODE_RETRIES; attempt += 1) {
    const code = generateReferralCodeCandidate();
    const existing = await client.query(
      `select 1
         from organizations
        where referral_code = $1
        limit 1`,
      [code]
    );
    if (!existing.rows[0]) return code;
  }
  return null; // vanishingly unlikely; the org simply stays code-less
}

async function createUserAndOrganization(client, email, supabaseUserId, refCode) {
  const organizationId = crypto.randomUUID();
  const userId = crypto.randomUUID();

  await client.query(
    `insert into organizations (id, name, created_at, updated_at)
     values ($1, $2, now(), now())`,
    [organizationId, 'New workspace']
  );

  // Assign the new org's referral code. Savepoint-wrapped so that a database
  // without the referral migration yet (or a code-generation failure) can
  // never break signup itself.
  try {
    await client.query('SAVEPOINT rv_referral_code');
    const referralCode = await generateUniqueReferralCode(client);
    if (referralCode) {
      await client.query(
        `update organizations
            set referral_code = $2
          where id = $1`,
        [organizationId, referralCode]
      );
    }
    await client.query('RELEASE SAVEPOINT rv_referral_code');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT rv_referral_code');
    console.error('Revessent onboard: could not assign a referral code:', error);
  }

  // Attribute the referral when the signup carried a valid ref code. Also
  // savepoint-wrapped — referrals are a growth nice-to-have, never a signup
  // requirement.
  if (refCode) {
    try {
      await client.query('SAVEPOINT rv_referral_link');
      const referrer = await client.query(
        `select id
           from organizations
          where referral_code = $1
            and id <> $2
          limit 1`,
        [refCode, organizationId]
      );

      if (referrer.rows[0]) {
        await client.query(
          `insert into referrals
             (referrer_organization_id, referred_organization_id, referral_code, signed_up_at)
           values
             ($1, $2, $3, now())`,
          [referrer.rows[0].id, organizationId, refCode]
        );
      }

      await client.query('RELEASE SAVEPOINT rv_referral_link');
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT rv_referral_link');
      console.error('Revessent onboard: could not record the referral:', error);
    }
  }

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
  // Optional referral code from the signup URL (?ref=CODE → login.html → here).
  const refCode = cleanString(body && body.ref).toUpperCase().slice(0, 32);

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

    // Only a genuinely NEW organization gets a referral code / can be
    // attributed as a referral — existing users signing in never do.
    if (!user) user = await createUserAndOrganization(client, email, supabaseUserId, refCode);

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
