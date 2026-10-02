// Revessent /api/recovery/bulk-approve (2nd-opinion #35 + audit #38 tail).
// Owner/admin approves the parked `awaiting_approval` cases in one action:
// each approved case sends its recovery email through the SAME path the cron
// uses (suppression-aware, unsubscribe footer, note + activity recorded).
// The click IS the approval — that's the trust-level contract.

const { Pool } = require('pg');
const { authenticateRequest } = require('../_lib/supabase-auth');
const { logAudit } = require('../_lib/audit');
const { sendRecoveryEmail } = require('./send-note');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1, // audit #45
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let client;
  try {
    const body = await readJsonBody(req);
    const caseIds = Array.isArray(body && body.caseIds)
      ? body.caseIds.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 100)
      : [];

    if (!caseIds.length) {
      return sendJson(res, 400, { error: 'caseIds (array) is required.' });
    }

    client = await pool.connect();
    const { user } = await authenticateRequest(req, client);

    if (!['owner', 'admin'].includes(String((user && user.role) || '').toLowerCase())) {
      return sendJson(res, 403, { error: 'Only workspace owners or admins can approve recovery outreach.' });
    }

    const organizationId = user.organization_id;

    // Only this org's parked cases are eligible — everything else is skipped
    // rather than erroring, so one stale id in the list can't block the batch.
    const eligible = await client.query(
      `select id from recovery_cases
        where organization_id = $1
          and status = 'awaiting_approval'
          and id = any($2::uuid[])`,
      [organizationId, caseIds]
    );

    let approved = 0;
    let failed = 0;
    const failures = [];

    for (const row of eligible.rows) {
      try {
        await sendRecoveryEmail({ client, organizationId, caseId: row.id, automatic: false, updateCaseStatus: true });
        approved += 1;
      } catch (error) {
        failed += 1;
        failures.push({ caseId: row.id, error: error.statusCode === 409 ? 'Recipient is suppressed — skipped.' : (error.message || 'Send failed.') });
        console.error('Revessent bulk-approve: case failed', row.id, error);
      }
    }

    await logAudit(client, { organizationId, userId: user.id, action: 'recovery.bulk_approved', detail: { requested: caseIds.length, approved, failed } });

    return sendJson(res, 200, {
      success: true,
      requested: caseIds.length,
      eligible: eligible.rows.length,
      approved,
      failed,
      failures,
    });
  } catch (error) {
    if (error.statusCode && [400, 401, 403].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }
    console.error('Revessent /api/recovery/bulk-approve failed:', error);
    return sendJson(res, 500, { error: 'Could not approve the recovery cases.' });
  } finally {
    if (client) client.release();
  }
};
