// Revessent /api/alerts/test
// "Send test alert" button endpoint: fires a fixed test payload to the
// authenticated user's own alert webhook, bypassing the minimum-amount
// threshold (force=true) so the user can verify their Slack/Discord setup
// regardless of the configured threshold.

const { Pool } = require('pg');
const { authenticateRequest } = require('../_lib/supabase-auth'); // audit #66: shared auth (local JWT verify when SUPABASE_JWT_SECRET is set)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zujmouzzqiovgbnanrvv.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_7JoawOBwMZ-ZIFmDrjkHSA_AdIWlCi3';

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let client;

  try {
    client = await pool.connect();
    const { user } = await authenticateRequest(req, client);
    // Audit #4: role check — only owners/admins may perform this action.
    if (!['owner', 'admin'].includes(String((user && user.role) || '').toLowerCase())) {
      return sendJson(res, 403, { error: 'Only workspace owners or admins can perform this action.' });
    }

    const organizationId = String(user.organization_id);

    // force: true skips the alert_min_amount_cents check for test sends only.
    const result = await require('./send').sendAlertIfConfigured(client, organizationId, {
      title: '🔔 Test alert from Revessent',
      amountCents: 0,
      currency: 'INR',
      force: true,
    });

    if (result.reason === 'not_configured') {
      return sendJson(res, 400, { error: 'No alert webhook configured. Save a Slack/Discord webhook URL in Settings first.' });
    }

    if (!result.sent) {
      return sendJson(res, 502, {
        error: result.reason === 'http_error'
          ? `The webhook responded with status ${result.status}. Check the URL and try again.`
          : `The test alert could not be delivered: ${result.error || 'unknown error'}`,
      });
    }

    return sendJson(res, 200, { success: true });
  } catch (error) {
    if (error.statusCode && [400, 401, 403].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }

    console.error('Revessent /api/alerts/test failed:', error);
    return sendJson(res, 500, { error: 'Could not send the test alert.' });
  } finally {
    if (client) client.release();
  }
};
