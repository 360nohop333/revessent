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
const { decryptColumns, encryptToString, decryptFromString } = require('../_lib/secret-box');
const { backfillRazorpayHistory } = require('./backfill');
const { authenticateRequest } = require('../_lib/supabase-auth');

const RAZORPAY_WEBHOOK_EVENTS = [
  'payment.failed',
  'payment.captured',
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
  max: 1,
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

  let webhookId = '';
  let reused = false;
  let webhookSecret = connection.webhook_secret ? decryptFromString(connection.webhook_secret) : '';

  const listResponse = await fetch('https://api.razorpay.com/v1/webhooks', {
    headers: { Authorization: razorpayAuthHeader(keyId, keySecret) },
  });
  const listBody = await listResponse.json().catch(() => ({}));
  const existing = (Array.isArray(listBody && listBody.items) ? listBody.items : [])
    .find((w) => cleanString(w && w.url) === url);

  if (existing) {
    const currentEvents = (Array.isArray(existing.events) ? existing.events : []).map((e) => cleanString(e && e.event)).filter(Boolean);
    const missing = RAZORPAY_WEBHOOK_EVENTS.filter((e) => !currentEvents.includes(e));
    if (missing.length) {
      const patchRes = await fetch(`https://api.razorpay.com/v1/webhooks/${encodeURIComponent(cleanString(existing.id))}`, {
        method: 'PATCH',
        headers: {
          Authorization: razorpayAuthHeader(keyId, keySecret),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url, active: true, events: RAZORPAY_WEBHOOK_EVENTS }),
      });
      if (!patchRes.ok) {
        console.warn(`[revessent] Failed to PATCH existing webhook ${existing.id} up to full event set (status ${patchRes.status})`);
      }
    }
  }

  let response;
  if (existing) {
    webhookId = cleanString(existing.id);
    reused = true;
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
  }

  if (!reused) webhookId = cleanString(body.id || body.webhook_id);

  await client.query(
    `update stripe_connections
        set webhook_endpoint_id = $2,
            webhook_secret = $3
      where id = $1`,
    [connection.id, webhookId || null, encryptToString(webhookSecret)]
  );

  return {
    webhookRegistered: true,
    webhookReused: reused,
    webhookId: webhookId || null,
    url,
  };
}

async function handler(req, res) {
  if (req.method === 'DELETE') {
    let client;
    try {
      client = await pool.connect();
      const { user } = await authenticateRequest(req, client);

      if (!['owner', 'admin'].includes(String((user && user.role) || '').toLowerCase())) {
        return sendJson(res, 403, { error: 'Only workspace owners and admins can change this.' });
      }

      const organizationId = user.organization_id;
      const connection = await loadActiveConnection(client, organizationId);
      if (!connection) {
        return sendJson(res, 404, { error: 'No active Razorpay connection found.' });
      }

      if (connection.webhook_endpoint_id) {
        try {
          const keyId = cleanString(connection.stripe_account_id);
          const keySecret = decryptSecret(connection);
          await fetch(`https://api.razorpay.com/v1/webhooks/${encodeURIComponent(cleanString(connection.webhook_endpoint_id))}`, {
            method: 'DELETE',
            headers: { Authorization: razorpayAuthHeader(keyId, keySecret) },
          });
        } catch (delErr) {
          console.warn('[revessent] Failed to remote-delete Razorpay webhook:', delErr);
        }
      }

      await client.query(
        `update stripe_connections
            set is_active = false,
                revoked_at = now()
          where id = $1`,
        [connection.id]
      );

      await logAudit(client, { organizationId, userId: user.id, action: 'razorpay.disconnected', detail: {} });
      return sendJson(res, 200, { success: true, disconnected: true });
    } catch (error) {
      if (error.statusCode && [400, 401, 403, 404].includes(error.statusCode)) {
        return sendJson(res, error.statusCode, { error: error.message });
      }
      console.error('Revessent /api/razorpay/connect DELETE failed:', error);
      return sendJson(res, 500, { error: 'Could not disconnect Razorpay.' });
    } finally {
      if (client) client.release();
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, DELETE');
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

    if (!['owner', 'admin'].includes(String((user && user.role) || '').toLowerCase())) {
      return sendJson(res, 403, { error: 'Only workspace owners and admins can change this.' });
    }

    const organizationId = requireSameOrganization(user, body && body.organizationId);
    const result = await registerRazorpayWebhook({ client, organizationId });
    await logAudit(client, { organizationId, userId: user.id, action: 'razorpay.connected', detail: { reused: result.webhookReused } });

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
