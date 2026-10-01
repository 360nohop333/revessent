// Revessent /api/keys
// API keys for programmatic access to an organization's own data (e.g. from a
// BI tool) without a Supabase session.
//
//   GET    — list this org's keys (prefix/label/dates only — never the key
//            itself or its hash)
//   POST   — create a key: 'rvsk_' + 32 random hex chars. The FULL key is
//            returned exactly once, in this response only. We store just the
//            first 12 chars (key_prefix, for display) and a SHA-256 hash of
//            the full key.
//   DELETE — revoke a key (sets revoked_at; the row is kept for history).

const { Pool } = require('pg');
const crypto = require('crypto');
const { logAudit } = require('./_lib/audit');
const { authenticateRequest } = require('./_lib/supabase-auth'); // audit #66: shared auth (local JWT verify when SUPABASE_JWT_SECRET is set)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zujmouzzqiovgbnanrvv.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_7JoawOBwMZ-ZIFmDrjkHSA_AdIWlCi3';
const KEY_PREFIX_LENGTH = 12; // 'rvsk_' + 7 hex chars
const KEY_CREATION_RETRIES = 5;

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

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// 'rvsk_' + 32 random hex chars. key_prefix holds the first 12 chars for
// display/identification; key_hash holds a SHA-256 of the FULL key — the raw
// key is never stored and never shown again after creation.
function generateApiKey() {
  const fullKey = `rvsk_${crypto.randomBytes(16).toString('hex')}`;
  return {
    fullKey,
    keyPrefix: fullKey.slice(0, KEY_PREFIX_LENGTH),
    keyHash: crypto.createHash('sha256').update(fullKey, 'utf8').digest('hex'),
  };
}

async function listKeys(client, organizationId) {
  const result = await client.query(
    `select id, key_prefix, label, created_at, last_used_at, revoked_at
       from api_keys
      where organization_id = $1
      order by created_at desc nulls last`,
    [organizationId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    keyPrefix: row.key_prefix || '',
    label: row.label || '',
    createdAt: toIso(row.created_at),
    lastUsedAt: toIso(row.last_used_at),
    revoked: Boolean(row.revoked_at),
  }));
}

async function handleGet(req, res, client, organizationId) {
  const keys = await listKeys(client, organizationId);
  return sendJson(res, 200, { keys });
}

async function handlePost(req, res, client, organizationId, userId) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (_) {
    return sendJson(res, 400, { error: 'Invalid JSON body.' });
  }

  const label = cleanString(body && body.label).slice(0, 120);

  // Retry on the (astronomically unlikely) key_prefix unique collision.
  for (let attempt = 0; attempt < KEY_CREATION_RETRIES; attempt += 1) {
    const key = generateApiKey();

    try {
      const inserted = await client.query(
        `insert into api_keys (id, organization_id, key_prefix, key_hash, label, created_at)
         values ($1, $2, $3, $4, nullif($5, ''), now())
         returning id, key_prefix`,
        [crypto.randomUUID(), organizationId, key.keyPrefix, key.keyHash, label]
      );

      // The ONLY response that ever contains the full key.
      await logAudit(client, { organizationId, userId, action: 'api_key.created', detail: { keyPrefix: key.keyPrefix, label } });
      return sendJson(res, 200, {
        success: true,
        apiKey: key.fullKey,
        id: inserted.rows[0].id,
        keyPrefix: inserted.rows[0].key_prefix,
      });
    } catch (error) {
      if (error && error.code === '23505') continue;
      throw error;
    }
  }

  return sendJson(res, 500, { error: 'Could not generate a unique API key. Please try again.' });
}

async function handleDelete(req, res, client, organizationId, userId) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (_) {
    return sendJson(res, 400, { error: 'Invalid JSON body.' });
  }

  const keyId = cleanString(body && body.keyId);
  if (!keyId) return sendJson(res, 400, { error: 'keyId is required.' });

  const result = await client.query(
    `update api_keys
        set revoked_at = now()
      where id = $1
        and organization_id = $2
        and revoked_at is null
      returning id`,
    [keyId, organizationId]
  );

  if (!result.rows[0]) {
    // Either never existed, belongs to another org, or was already revoked —
    // treat as not found so we don't leak other orgs' key ids.
    return sendJson(res, 404, { error: 'API key not found.' });
  }

  await logAudit(client, { organizationId, userId, action: 'api_key.revoked', detail: { keyId } });
  return sendJson(res, 200, { success: true });
}

module.exports = async (req, res) => {
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let client;

  try {
    client = await pool.connect();
    const { user } = await authenticateRequest(req, client);
    const organizationId = user.organization_id;

    // Audit #4: role check — only owners/admins may perform create or revoke API keys.
    if (!['owner', 'admin'].includes(String((user && user.role) || '').toLowerCase())) {
      return sendJson(res, 403, { error: 'Only workspace owners or admins can perform create or revoke API keys.' });
    }

    if (req.method === 'GET') return await handleGet(req, res, client, organizationId);
    if (req.method === 'POST') return await handlePost(req, res, client, organizationId, user.id);
    return await handleDelete(req, res, client, organizationId, user.id);
  } catch (error) {
    if (error.statusCode && [400, 401, 403, 404].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }

    console.error('Revessent /api/keys failed:', error);
    return sendJson(res, 500, { error: 'Could not manage API keys.' });
  } finally {
    if (client) client.release();
  }
};
