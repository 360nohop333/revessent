// Revessent /api/audit (audit #16) — read the privileged-action trail.
// Owner/admin only. The writes happen in _lib/audit.js (best-effort).

const { Pool } = require('pg');

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

const { authenticateRequest } = require('./_lib/supabase-auth'); // audit #66: shared auth

function cleanString(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 300);
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

    // Same gate as the actions being audited.
    if (!['owner', 'admin'].includes(String((user && user.role) || '').toLowerCase())) {
      return sendJson(res, 403, { error: 'Only workspace owners or admins can view the audit log.' });
    }

    const limit = Math.min(200, Math.max(1, Number((req.query && req.query.limit) || 50) || 50));

    const result = await client.query(
      `select a.id, a.action, a.detail, a.created_at, u.email as user_email
         from audit_log a
         left join users u on u.id = a.user_id
        where a.organization_id = $1
        order by a.created_at desc
        limit $2`,
      [user.organization_id, limit]
    );

    return sendJson(res, 200, {
      audit: result.rows.map((row) => ({
        id: row.id,
        action: row.action || '',
        detail: row.detail || {},
        userEmail: row.user_email || '',
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      })),
    });
  } catch (error) {
    if (error.statusCode && [400, 401, 403].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }
    console.error('Revessent /api/audit failed:', error);
    return sendJson(res, 500, { error: 'Could not load the audit log.' });
  } finally {
    if (client) client.release();
  }
};
