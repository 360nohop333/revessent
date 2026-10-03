// Revessent /api/razorpay/connect
// Registers a Razorpay webhook for the authenticated organization.
//
// This file is both an HTTP endpoint and an internal helper. api/settings.js
// imports registerRazorpayWebhook() and calls it after Razorpay credentials
// are saved, so users do not have to manually create webhooks in Razorpay.
//
// After the webhook is registered, the 90-day historical scan
// (backfillRazorpayHistory from api/razorpay/backfill.js) runs as a separate,
// best-effort step: if the scan fails, the error is logged server-side but the
// request still succeeds — the live webhook going forward is the important
// thing working, the backfill is a nice-to-have enhancement.

const { Pool } = require('pg');
const crypto = require('crypto');
const { logAudit } = require('../_lib/audit');
const { decryptColumns, encryptToString, decryptFromString } = require('../_lib/secret-box'); // audit #7
const { backfillRazorpayHistory } = require('./backfill');
const { authenticateRequest } = require('../_lib/supabase-auth'); // audit #66: shared auth (local JWT verify when SUPABASE_JWT_SECRET is set)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zujmouzzqiovgbnanrvv.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_7JoawOBwMZ-ZIFmDrjkHSA_AdIWlCi3';
const RAZORPAY_WEBHOOK_EVENTS = [
  'payment.failed',
  'payment.captured',
  // audit #24: subscription lifecycle + refunds
  'subscription.charged',
  'subscription.cancelled',
  'subscription.halted',
  'subscription.resumed',
  'subscription.completed',
  'refund.processed',
];
const DEFAULT_WEBHOOK_BASE_URL = 'https://revessent-alpha.vercel.app';

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

function cleanString(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeId(value) {
  return value == null ? '' : String(value).trim();
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

// Audit #7: decryption lives in _lib/secret-box — it tries ENCRYPTION_KEY,
// then ENCRYPTION_KEY_OLD, so keys can be rotated without breaking saved
// Razorpay connections.
function decryptSecret(connection) {
  return decryptColumns(connection.encrypted_restricted_key, connection.key_iv, connection.key_tag);
}

function razorpayAuthHeader(keyId, keySecret) {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64')}`;
}

function webhookBaseUrl() {
  return cleanString(process.env.PUBLIC_APP_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || DEFAULT_WEBHOOK_BASE_URL)
    .replace(/\/$/, '')
    .replace(/^([^h])/, 'https://$1');
}

async function loadActiveConnection(client, organizationId) {
  const result = await client.query(
    `select id, organization_id, stripe_account_id, encrypted_restricted_key, key_iv, key_tag, is_active, webhook_secret
       from stripe_connections
      where organization_id = $1
        and is_active = true
      order by connected_at desc nulls last
      limit 1`,
    [organizationId]
  );

  return result.rows[0] || null;
}

async function registerRazorpayWebhook({ client, organizationId }) {
  const connection = await loadActiveConnection(client, organizationId);

  if (!connection || !connection.is_active) {
    const error = new Error('Connect Razorpay first.');
    error.statusCode = 400;
    throw error;
  }

  const keyId = cleanString(connection.stripe_account_id);
  const keySecret = decryptSecret(connection);
  const url = `${webhookBaseUrl()}/api/webhooks/razorpay?org=${encodeURIComponent(organizationId)}`;

  // Audit #34: re-saving keys used to register a NEW webhook every time.
  // List existing webhooks first; if ours is already registered, reuse it and
  // keep the stored secret (rotating here would break signature verification
  // — Razorpay's API offers no webhook-secret update) instead of duplicating.
  let webhookId = '';
  let reused = false;
  // Audit #7: read through the secret box so both enc:v1 ciphertext and
  // legacy plaintext work; new saves always write ciphertext.
  let webhookSecret = connection.webhook_secret ? decryptFromString(connection.webhook_secret) : '';

  const listResponse = await fetch('https://api.razorpay.com/v1/webhooks', {
    headers: { Authorization: razorpayAuthHeader(keyId, keySecret) },
  });
  const listBody = await listResponse.json().catch(() => ({}));
  const existing = (Array.isArray(listBody && listBody.items) ? listBody.items : [])
    .find((w) => cleanString(w && w.url) === url);
  // Audit #24: an existing webhook may predate the subscription/refund
  // events. PATCH it up to the full event set (secret untouched) instead of
  // silently never receiving them.
  if (existing) {
    const currentEvents = (Array.isArray(existing.events) ? existing.events : []).map((e) => cleanString(e && e.event)).filter(Boolean);
    const missing = RAZORPAY_WEBHOOK_EVENTS.filter((e) => !currentEvents.includes(e));
    if (missing.length) {
      await fetch(`https://api.razorpay.com/v1/webhooks/${encodeURIComponent(cleanString(existing.id))}`, {
        method: 'PATCH',
        headers: {
          Authorization: razorpayAuthHeader(keyId, keySecret),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url, active: true, events: RAZORPAY_WEBHOOK_EVENTS }),
      });
    }
  }

  let response;
  if (existing) {
    webhookId = cleanString(existing.id);
    reused = true;
    // Reusing but we have no stored secret (legacy connection): recover it
    // from the webhook-detail endpoint if Razorpay returns it. Saving a fresh
    // random secret here would silently break signature verification.
    if (!webhookSecret) {
      const detailResponse = await fetch(`https://api.razorpay.com/v1/webhooks/${encodeURIComponent(webhookId)}`, {
        headers: { Authorization: razorpayAuthHeader(keyId, keySecret) },
      });
      const detailBody = await detailResponse.json().catch(() => ({}));
      const recovered = cleanString(detailBody && (detailBody.secret || (detailBody.webhook && detailBody.webhook.secret)));
      if (!recovered) {
        const error = new Error(
          'A webhook for this URL already exists in your Razorpay account, but its signing secret is not stored here. ' +
          'Delete that webhook in Razorpay → Settings → Webhooks, then reconnect — Revessent will register a fresh one.'
        );
        error.statusCode = 400;
        throw error;
      }
      webhookSecret = recovered;
    }
  } else {
    webhookSecret = crypto.randomBytes(32).toString('hex');
    response = await fetch('https://api.razorpay.com/v1/webhooks', {
      method: 'POST',
      headers: {
        Authorization: razorpayAuthHeader(keyId, keySecret),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        active: true,
        events: RAZORPAY_WEBHOOK_EVENTS,
        secret: webhookSecret,
      }),
    });

    const body = await response.json().catch(() => ({}));

    if (!reused && !response.ok) {
      const message =
        cleanString(body && body.error && body.error.description) ||
        cleanString(body && body.error && body.error.reason) ||
        cleanString(body && body.message) ||
        'Could not verify Razorpay credentials — check your Key ID and Secret are correct and active.';

      const error = new Error(`Could not verify Razorpay credentials — ${message}`);
      error.statusCode = response.status === 401 || response.status === 403 ? 400 : 502;
      error.razorpayBody = body;
      throw error;
    }
  } // end else (webhook created via API)

  if (!reused) webhookId = cleanString(body.id || body.webhook_id);

  await client.query(
    `update stripe_connections
        set webhook_endpoint_id = $2,
            webhook_secret = $3
      where id = $1`,
    // Audit #7: webhook secret now encrypted at rest (enc:v1 format).
    [connection.id, webhookId || null, encryptToString(webhookSecret)]
  );

  return {
    webhookRegistered: true,
    webhookReused: reused,
    webhookId: webhookId || null,
    webhookSecret,
    url,
    // Manual fallback (audit #17): everything needed to add the webhook by
    // hand in the Razorpay dashboard if the API path ever fails.
    manualSetup: reused
      ? null
      : `In Razorpay → Settings → Webhooks, add URL ${url} with secret ${webhookSecret} and events: ${RAZORPAY_WEBHOOK_EVENTS.join(', ')}.`,
  };
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

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

    // Audit #4: for POST/PATCH methods only (GET stays open to any org member),
    // if user.role is not 'owner' or 'admin', return 403.
    if (!['owner', 'admin'].includes(String((user && user.role) || '').toLowerCase())) {
      return sendJson(res, 403, { error: 'Only workspace owners and admins can change this.' });
    }

    const organizationId = requireSameOrganization(user, body && body.organizationId);
    const result = await registerRazorpayWebhook({ client, organizationId });
    await logAudit(client, { organizationId, userId: user.id, action: 'razorpay.connected', detail: { reused: result.webhookReused } });

    // Separate, best-effort step after the webhook registration succeeds:
    // scan the last 90 days of Razorpay history for missed failed payments.
    // Its failure must NOT fail this request (or the underlying settings
    // save) — log it and still report the connection as successful.
    let backfill = null;

    try {
      backfill = await backfillRazorpayHistory({ client, organizationId });
    } catch (backfillError) {
      console.error('Revessent Razorpay 90-day backfill failed after webhook registration:', backfillError);
      backfill = { error: backfillError.message || 'Historical scan failed.' };
    }

    return sendJson(res, 200, {
      success: true,
      webhookRegistered: result.webhookRegistered,
      webhookId: result.webhookId,
      webhookUrl: result.url,
      backfill,
    });
  } catch (error) {
    if (error.statusCode && [400, 401, 403].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }

    if (error.statusCode === 502) {
      return sendJson(res, 502, { error: error.message });
    }

    console.error('Revessent /api/razorpay/connect failed:', error);
    return sendJson(res, 500, { error: 'Could not register Razorpay webhook.' });
  } finally {
    if (client) client.release();
  }
}

module.exports = handler;
module.exports.registerRazorpayWebhook = registerRazorpayWebhook;
