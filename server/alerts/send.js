// Revessent /api/alerts/send
// Slack/Discord webhook alerts. This file is primarily an internal helper:
// sendAlertIfConfigured(client, organizationId, { title, amountCents,
// currency, force }) is imported by api/webhooks/razorpay.js and
// api/recovery/retry.js to fire alerts when something important happens
// (a big recovery, a high-value failure). It is also exposed as a POST
// endpoint so an authenticated user can send a custom alert to their own
// webhook on demand.
//
// The payload { text: "…" } is the one shape both Slack's and Discord's
// simple incoming webhooks accept, so there's no need to detect the platform.

const { Pool } = require('pg');

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

function getBearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function verifySupabaseToken(token) {
  if (!token) {
    const error = new Error('Missing authorization token.');
    error.statusCode = 401;
    throw error;
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
    },
  });

  if (!response.ok) {
    const error = new Error('Invalid or expired authorization token.');
    error.statusCode = 401;
    throw error;
  }

  const supabaseUser = await response.json();
  const supabaseUserId = (supabaseUser && supabaseUser.id ? String(supabaseUser.id) : '').trim();
  const email = (supabaseUser && supabaseUser.email ? String(supabaseUser.email) : '').trim().toLowerCase();

  if (!supabaseUserId) {
    const error = new Error('Supabase user id is missing.');
    error.statusCode = 401;
    throw error;
  }

  if (!email) {
    const error = new Error('Supabase user has no email address.');
    error.statusCode = 401;
    throw error;
  }

  return { email, supabaseUserId };
}

async function findNeonUserBySupabaseId(client, supabaseUserId) {
  const result = await client.query(
    `select id, organization_id, email, role, supabase_user_id
       from users
      where supabase_user_id = $1
      limit 1`,
    [supabaseUserId]
  );

  return result.rows[0] || null;
}

async function findNeonUserByEmail(client, email) {
  const result = await client.query(
    `select id, organization_id, email, role, supabase_user_id
       from users
      where lower(email) = lower($1)
      limit 1`,
    [email]
  );

  return result.rows[0] || null;
}

async function backfillSupabaseUserId(client, user, supabaseUserId) {
  if (!user || !supabaseUserId || user.supabase_user_id) return user;

  try {
    const result = await client.query(
      `update users
          set supabase_user_id = $1
        where id = $2
          and supabase_user_id is null
      returning id, organization_id, email, role, supabase_user_id`,
      [supabaseUserId, user.id]
    );

    return result.rows[0] || user;
  } catch (error) {
    if (error && error.code === '23505') {
      const boundUser = await findNeonUserBySupabaseId(client, supabaseUserId);
      if (boundUser && String(boundUser.id) === String(user.id)) return boundUser;
    }
    throw error;
  }
}

async function authenticateRequest(req, client) {
  const token = getBearerToken(req);
  const { email, supabaseUserId } = await verifySupabaseToken(token);
  let user = await findNeonUserBySupabaseId(client, supabaseUserId);

  if (!user) {
    user = await findNeonUserByEmail(client, email);

    if (user && user.supabase_user_id && user.supabase_user_id !== supabaseUserId) {
      const error = new Error('Supabase account is already bound to a different Revessent user.');
      error.statusCode = 401;
      throw error;
    }

    if (user) user = await backfillSupabaseUserId(client, user, supabaseUserId);
  }

  if (!user) {
    const error = new Error('No Revessent user found for this Supabase account.');
    error.statusCode = 401;
    throw error;
  }

  return { token, email, supabaseUserId, user };
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

function toInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function formatAmountLabel(amountCents, currency) {
  const amount = (Number(amountCents || 0) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return `${cleanString(currency || 'INR').toUpperCase()} ${amount}`;
}

// Looks up the org's alert_webhook_url + alert_min_amount_cents. If no webhook
// is configured, or the amount is below the threshold (unless options.force),
// it quietly does nothing. Otherwise POSTs { text: "title — amount" } to the
// stored webhook. NEVER throws — a broken alert webhook must never break the
// recovery flow that called it. Returns { sent, reason?, error? } so test
// sends can report why nothing went out.
async function sendAlertIfConfigured(client, organizationId, alert = {}) {
  try {
    const result = await client.query(
      `select alert_webhook_url, alert_min_amount_cents
         from organizations
        where id = $1
        limit 1`,
      [organizationId]
    );

    const org = result.rows[0] || null;
    if (!org || !cleanString(org.alert_webhook_url)) {
      return { sent: false, reason: 'not_configured' };
    }

    const amountCents = Number(alert.amountCents);
    const threshold = toInt(org.alert_min_amount_cents, 0);
    if (!alert.force && Number.isFinite(amountCents) && amountCents < threshold) {
      return { sent: false, reason: 'below_threshold' };
    }

    // "title — amount" when a real amount is attached; title alone for
    // zero-amount/test sends.
    const title = cleanString(alert.title) || 'Revessent alert';
    const text =
      Number.isFinite(amountCents) && amountCents > 0
        ? `${title} — ${formatAmountLabel(amountCents, alert.currency)}`
        : title;

    const response = await fetch(cleanString(org.alert_webhook_url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      console.error(`Revessent alert webhook responded ${response.status} for org ${organizationId}.`);
      return { sent: false, reason: 'http_error', status: response.status };
    }

    return { sent: true };
  } catch (error) {
    console.error('Revessent alert send failed:', error);
    return { sent: false, reason: 'error', error: error.message };
  }
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
    // Audit #4: role check — only owners/admins may perform this action.
    if (!['owner', 'admin'].includes(String((user && user.role) || '').toLowerCase())) {
      return sendJson(res, 403, { error: 'Only workspace owners or admins can perform this action.' });
    }


    // Safer pattern: ignore any client-sent org id and always alert the
    // authenticated user's own organization.
    const organizationId = String(user.organization_id);

    // Explicit user action — always send (force skips the min-amount check).
    const result = await sendAlertIfConfigured(client, organizationId, {
      title: cleanString(body && body.title) || '🔔 Alert from Revessent',
      amountCents: body && body.amountCents,
      currency: cleanString(body && body.currency) || 'INR',
      force: true,
    });

    if (result.reason === 'not_configured') {
      return sendJson(res, 400, { error: 'No alert webhook configured. Save a Slack/Discord webhook URL in Settings first.' });
    }

    if (!result.sent) {
      return sendJson(res, 502, {
        error: result.reason === 'http_error'
          ? `The webhook responded with status ${result.status}.`
          : 'The alert could not be delivered. Check the webhook URL.',
      });
    }

    return sendJson(res, 200, { success: true });
  } catch (error) {
    if (error.statusCode && [400, 401, 403].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }

    console.error('Revessent /api/alerts/send failed:', error);
    return sendJson(res, 500, { error: 'Could not send alert.' });
  } finally {
    if (client) client.release();
  }
}

module.exports = handler;
module.exports.sendAlertIfConfigured = sendAlertIfConfigured;
