// /api/onboard.js
// Called right after a successful Supabase signup or first sign-in.
// Creates a matching organization + user row in Neon, if one doesn't
// already exist for this Supabase user id. Safe to call more than once —
// it checks first and does nothing if the user is already onboarded.

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function slugify(email) {
  const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base}-${suffix}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { supabaseUserId, email } = req.body || {};

  if (!supabaseUserId || !email) {
    res.status(400).json({ error: 'Missing supabaseUserId or email' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id, organization_id FROM users WHERE email = $1 LIMIT 1',
      [email]
    );

    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      res.status(200).json({
        alreadyExists: true,
        userId: existing.rows[0].id,
        organizationId: existing.rows[0].organization_id,
      });
      return;
    }

    const slug = slugify(email);
    const orgResult = await client.query(
      `INSERT INTO organizations (name, slug, plan, trust_level)
       VALUES ($1, $2, 'ember', 'approval_required')
       RETURNING id`,
      [`${email.split('@')[0]}'s workspace`, slug]
    );
    const organizationId = orgResult.rows[0].id;

    const userResult = await client.query(
      `INSERT INTO users (organization_id, email, role, email_verified)
       VALUES ($1, $2, 'owner', true)
       RETURNING id`,
      [organizationId, email]
    );
    const userId = userResult.rows[0].id;

    await client.query('COMMIT');

    res.status(200).json({
      alreadyExists: false,
      userId,
      organizationId,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Onboarding error:', err);
    res.status(500).json({ error: 'Failed to onboard user', detail: err.message });
  } finally {
    client.release();
  }
};
