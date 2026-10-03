// Revessent /api/recovery/case
// Loads one recovery case, its retry attempts, and recovery notes for the
// authenticated user's organization.

const { Pool } = require('pg');
const { authenticateRequest } = require('../_lib/supabase-auth');

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

function getQueryParam(req, key) {
  if (req.query && req.query[key] != null) return String(req.query[key]);
  try {
    const url = new URL(req.url, 'https://revessent.local');
    return url.searchParams.get(key) || '';
  } catch (_) {
    return '';
  }
}

function cleanString(value) {
  return value == null ? '' : String(value).trim();
}

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  const caseId = cleanString(getQueryParam(req, 'caseId'));
  if (!caseId) return sendJson(res, 400, { error: 'caseId is required.' });

  let client;

  try {
    client = await pool.connect();
    const { user } = await authenticateRequest(req, client);
    const organizationId = user.organization_id;

    const caseResult = await client.query(
      `select
         rc.id,
         rc.organization_id,
         rc.amount_cents,
         rc.currency,
         rc.status,
         rc.decline_code,
         rc.retry_count,
         rc.max_retries,
         rc.failed_at,
         sm.name as member_name,
         sm.email as member_email,
         sm.phone as member_phone
       from recovery_cases rc
       join stripe_members sm on sm.id = rc.member_id
       where rc.id = $1
       limit 1`,
      [caseId]
    );

    const row = caseResult.rows[0] || null;
    if (!row) return sendJson(res, 404, { error: 'Recovery case not found.' });
    if (String(row.organization_id) !== String(organizationId)) {
      return sendJson(res, 403, { error: 'You do not have access to this recovery case.' });
    }

    const [attemptsResult, notesResult] = await Promise.all([
      client.query(
        `select id, type, status, error_code, error_message, executed_at, created_at
           from recovery_attempts
          where case_id = $1
          order by created_at desc nulls last`,
        [caseId]
      ),
      client.query(
        `select id, subject, body, channel, requires_approval, sent_at, created_at
           from recovery_notes
          where case_id = $1
          order by created_at desc nulls last`,
        [caseId]
      ),
    ]);

    return sendJson(res, 200, {
      case: {
        id: row.id,
        memberName: row.member_name || '',
        memberEmail: row.member_email || '',
        memberPhone: row.member_phone || '',
        amountCents: toInt(row.amount_cents),
        currency: row.currency || 'INR',
        status: row.status || 'detected',
        declineCode: row.decline_code || 'unknown',
        retryCount: toInt(row.retry_count),
        maxRetries: toInt(row.max_retries),
        failedAt: toIso(row.failed_at),
      },
      attempts: attemptsResult.rows.map((attempt) => ({
        id: attempt.id,
        type: attempt.type || '',
        status: attempt.status || '',
        errorCode: attempt.error_code || '',
        errorMessage: attempt.error_message || '',
        executedAt: toIso(attempt.executed_at || attempt.created_at),
      })),
      notes: notesResult.rows.map((note) => ({
        id: note.id,
        subject: note.subject || '',
        body: note.body || '',
        channel: note.channel || 'email',
        requiresApproval: Boolean(note.requires_approval),
        sentAt: toIso(note.sent_at),
        createdAt: toIso(note.created_at),
      })),
    });
  } catch (error) {
    if (error.statusCode && [400, 401, 403, 404].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }

    console.error('Revessent /api/recovery/case failed:', error);
    return sendJson(res, 500, { error: 'Could not load recovery case.' });
  } finally {
    if (client) client.release();
  }
};
