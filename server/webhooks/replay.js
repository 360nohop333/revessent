// Revessent /api/webhooks/replay (2nd-opinion #34) — operator replay of a
// stored Razorpay event: failed webhook → inspect (GET /api/audit shows
// activity; the event row keeps processing_error) → replay → see result.
// Owner/admin only; audit-logged.

const { Pool } = require('pg');
const { authenticateRequest } = require('../_lib/supabase-auth');
const { logAudit } = require('../_lib/audit');
const { replayWebhookEvent } = require('./razorpay');

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
    const eventId = String((body && body.eventId) || '').trim();
    if (!eventId) return sendJson(res, 400, { error: 'eventId is required.' });

    client = await pool.connect();
    const { user } = await authenticateRequest(req, client);

    if (!['owner', 'admin'].includes(String((user && user.role) || '').toLowerCase())) {
      return sendJson(res, 403, { error: 'Only workspace owners or admins can replay webhook events.' });
    }

    const organizationId = user.organization_id;
    const outcome = await replayWebhookEvent(client, organizationId, eventId);

    await logAudit(client, { organizationId, userId: user.id, action: 'webhook.replayed', detail: { eventId, outcome } });

    return sendJson(res, 200, { success: true, eventId, outcome });
  } catch (error) {
    if (error.statusCode && [400, 401, 403, 404].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }
    console.error('Revessent /api/webhooks/replay failed:', error);
    return sendJson(res, 500, { error: 'Could not replay the webhook event.' });
  } finally {
    if (client) client.release();
  }
};
