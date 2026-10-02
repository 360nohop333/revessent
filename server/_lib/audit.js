// Revessent audit log helper (audit #16).
// Best-effort: an audit failure must NEVER break the action being audited.
// SQL: see AUDIT.md migration block (audit_log table).

const crypto = require('crypto');

async function logAudit(client, { organizationId, userId = null, action, detail = {} }) {
  try {
    await client.query(
      `insert into audit_log (id, organization_id, user_id, action, detail, created_at)
       values ($1, $2, $3, $4, $5::jsonb, now())`,
      [crypto.randomUUID(), organizationId, userId, action, JSON.stringify(detail || {})]
    );
  } catch (error) {
    // Pre-migration (table missing) or transient failure — log and move on.
    console.error('Revessent audit log write failed:', error && error.message);
  }
}

module.exports = { logAudit };
