// Revessent /api/organization
// Updates organization profile fields for the authenticated user's own org.

const { Pool } = require('pg');
const { authenticateRequest } = require('./_lib/supabase-auth');
const { logAudit } = require('./_lib/audit');

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
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (typeof req.body === 'string') {
    return req.body ? JSON.parse(req.body) : {};
  }

  if (Buffer.isBuffer(req.body)) {
    const raw = req.body.toString('utf8');
    return raw ? JSON.parse(raw) : {};
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function normalizeId(value) {
  return value == null ? '' : String(value).trim();
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requireSameOrganization(user, organizationId) {
  const requested = normalizeId(organizationId);
  const actual = normalizeId(user.organization_id);

  if (!requested) {
    const error = new Error('organizationId is required.');
    error.statusCode = 400;
    throw error;
  }

  if (requested !== actual) {
    const error = new Error('You do not have access to this organization.');
    error.statusCode = 403;
    throw error;
  }

  return requested;
}

// Audit #60: delete the entire workspace (owner only, typed confirmation).
// ON DELETE CASCADE wipes cases, notes, members, subscriptions, keys, audit
// rows — everything tied to the org. The Supabase LOGIN itself is not
// deletable from here (that needs a service-role key we deliberately don't
// hold); the client signs the user out and points them at support.
async function handleDelete(req, res, client, user, body) {
  if (String((user && user.role) || '').toLowerCase() !== 'owner') {
    return sendJson(res, 403, { error: 'Only the workspace owner can delete it.' });
  }

  const confirmation = String((body && body.confirm) || '').trim().toUpperCase();
  if (confirmation !== 'DELETE') {
    return sendJson(res, 400, { error: 'Type DELETE to confirm workspace removal.' });
  }

  // The workspace being deleted is the caller's own unless explicitly stated.
  const organizationId = requireSameOrganization(user, (body && body.organizationId) || user.organization_id);

  await client.query('BEGIN');
  try {
    // 2nd-opinion #23: the audit row dies with the cascade — write a
    // durable, FK-free deletion record that survives the org it describes.
    const orgRow = await client.query(
      `select name from organizations where id = $1 limit 1`,
      [organizationId]
    );
    await client.query(
      `insert into deletion_log (id, organization_id, organization_name, user_email, deleted_at)
       values ($1, $2, $3, $4, now())`,
      [require('crypto').randomUUID(), organizationId, (orgRow.rows[0] || {}).name || '', user.email || '']
    );
    // Last visible trail before the cascade removes the audit rows too.
    await logAudit(client, {
      organizationId,
      userId: user.id,
      action: 'organization.deleted',
      detail: { email: user.email || '' },
    });
    const result = await client.query(
      `delete from organizations where id = $1 returning id`,
      [organizationId]
    );
    await client.query('COMMIT');
    if (!result.rows[0]) return sendJson(res, 404, { error: 'Organization not found.' });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  }

  return sendJson(res, 200, { success: true, deleted: true });
}

module.exports = async (req, res) => {
  if (req.method === 'DELETE') {
    let body;
    let client;
    try {
      body = await readJsonBody(req);
    } catch (_) {
      return sendJson(res, 400, { error: 'Invalid JSON body.' });
    }
    try {
      client = await pool.connect();
      const { user } = await authenticateRequest(req, client);
      return await handleDelete(req, res, client, user, body);
    } catch (error) {
      if (error.statusCode && [400, 401, 403].includes(error.statusCode)) {
        return sendJson(res, error.statusCode, { error: error.message });
      }
      console.error('Revessent DELETE /api/organization failed:', error);
      return sendJson(res, 500, { error: 'Could not delete the workspace.' });
    } finally {
      if (client) client.release();
    }
  }

  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'GET, PATCH, DELETE');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let body;
  let client;

  try {
    body = await readJsonBody(req);
  } catch (_) {
    return sendJson(res, 400, { error: 'Invalid JSON body.' });
  }

  const name = cleanString(body && body.name);

  if (!name) return sendJson(res, 400, { error: 'Workspace name is required.' });
  if (name.length > 120) return sendJson(res, 400, { error: 'Workspace name is too long.' });

  try {
    client = await pool.connect();
    const { user } = await authenticateRequest(req, client);

    // Audit #4: for POST/PATCH methods only (GET stays open to any org member),
    // if user.role is not 'owner' or 'admin', return 403.
    if (!['owner', 'admin'].includes(String((user && user.role) || '').toLowerCase())) {
      return sendJson(res, 403, { error: 'Only workspace owners and admins can change this.' });
    }

    const organizationId = requireSameOrganization(user, body && body.organizationId);

    const result = await client.query(
      `update organizations
          set name = $1,
              updated_at = now()
        where id = $2
        returning id, name`,
      [name, organizationId]
    );

    if (!result.rows[0]) return sendJson(res, 404, { error: 'Organization not found.' });

    return sendJson(res, 200, {
      success: true,
      organizationId: result.rows[0].id,
      name: result.rows[0].name,
    });
  } catch (error) {
    if (error.statusCode && [400, 401, 403].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }

    console.error('Revessent /api/organization failed:', error);
    return sendJson(res, 500, { error: 'Could not update organization.' });
  } finally {
    if (client) client.release();
  }
};
