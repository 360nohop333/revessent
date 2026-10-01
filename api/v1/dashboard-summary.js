// Revessent /api/v1/dashboard-summary
// SIMPLE example of an API-key-protected endpoint (NOT Supabase auth) — the
// pattern server-to-server clients use: send the full key in the X-API-Key
// header. We look the key up by its 12-char prefix, verify the full key's
// SHA-256 against the stored key_hash with a constant-time compare, stamp
// last_used_at, and return a minimal subset of dashboard data scoped to that
// key's organization.
//
//   curl -H "X-API-Key: rvsk_…" https://…/api/v1/dashboard-summary

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

function cleanString(value) {
  return value == null ? '' : String(value).trim();
}

function toInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Resolve an X-API-Key header to the api_keys row it belongs to, or null.
// Prefix lookup + constant-time hash comparison (crypto.timingSafeEqual on the
// two 32-byte SHA-256 digests).
async function resolveApiKey(client, fullKey) {
  const key = cleanString(fullKey);
  if (key.length < 13) return null; // shorter than 'rvsk_' + 7 chars can't match a prefix

  const keyPrefix = key.slice(0, 12);
  const hash = crypto.createHash('sha256').update(key, 'utf8').digest();

  const result = await client.query(
    `select id, organization_id, key_hash
       from api_keys
      where key_prefix = $1
        and revoked_at is null
      limit 1`,
    [keyPrefix]
  );

  const record = result.rows[0] || null;
  if (!record) return null;

  let stored;
  try {
    stored = Buffer.from(record.key_hash || '', 'hex');
  } catch (_) {
    return null;
  }

  if (stored.length !== hash.length || !crypto.timingSafeEqual(stored, hash)) {
    return null;
  }

  return record;
}

// Minimal versions of api/dashboard-data.js's revenueRecovered/revenueAtRisk
// queries (kept deliberately small — this is the example API-key endpoint).
async function getRevenueRecovered(client, organizationId) {
  const result = await client.query(
    `select coalesce(sum(amount_cents), 0)::bigint as current_cents
       from recovery_attributions
      where organization_id = $1
        and recovered_at >= now() - interval '30 days'`,
    [organizationId]
  );

  return { amountCents: toInt(result.rows[0] ? result.rows[0].current_cents : 0), rangeDays: 30 };
}

async function getRevenueAtRisk(client, organizationId) {
  const result = await client.query(
    `select coalesce(sum(amount_cents), 0)::bigint as amount_cents,
            count(*)::int as open_case_count
       from recovery_cases
      where organization_id = $1
        and status not in ('recovered', 'lost', 'canceled')`,
    [organizationId]
  );

  const row = result.rows[0] || {};
  return {
    amountCents: toInt(row.amount_cents),
    openCaseCount: toInt(row.open_case_count),
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let client;

  try {
    client = await pool.connect();

    const fullKey =
      req.headers['x-api-key'] ||
      req.headers['X-API-Key'] ||
      req.headers['X-Api-Key'] ||
      '';

    if (!cleanString(fullKey)) {
      return sendJson(res, 401, { error: 'X-API-Key header is required.' });
    }

    const keyRecord = await resolveApiKey(client, fullKey);
    if (!keyRecord) {
      return sendJson(res, 401, { error: 'Invalid or revoked API key.' });
    }

    // Best-effort usage stamp — a failure here must not fail the request.
    try {
      await client.query(`update api_keys set last_used_at = now() where id = $1`, [keyRecord.id]);
    } catch (stampError) {
      console.error('Revessent /api/v1/dashboard-summary could not stamp last_used_at:', stampError);
    }

    const [revenueRecovered, revenueAtRisk] = await Promise.all([
      getRevenueRecovered(client, keyRecord.organization_id),
      getRevenueAtRisk(client, keyRecord.organization_id),
    ]);

    return sendJson(res, 200, {
      generatedAt: toIso(new Date()),
      revenueRecovered,
      revenueAtRisk,
    });
  } catch (error) {
    console.error('Revessent /api/v1/dashboard-summary failed:', error);
    return sendJson(res, 500, { error: 'Could not load dashboard summary.' });
  } finally {
    if (client) client.release();
  }
};
