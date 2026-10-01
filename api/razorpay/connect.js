// Revessent /api/razorpay/connect
// Registers a Razorpay webhook for the authenticated organization.
//
// This file is both an HTTP endpoint and an internal helper. api/settings.js
// imports registerRazorpayWebhook() and calls it after Razorpay credentials
// are saved, so users do not have to manually create webhooks in Razorpay.

const { Pool } = require('pg');
const crypto = require('crypto');

const SUPABASE_URL = 'https://zujmouzzqiovgbnanrvv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7JoawOBwMZ-ZIFmDrjkHSA_AdIWlCi3';
const RAZORPAY_WEBHOOK_EVENTS = ['payment.failed', 'payment.captured'];
const DEFAULT_WEBHOOK_BASE_URL = 'https://revessent-alpha.vercel.app';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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

function getEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY;

  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
    const error = new Error('Encryption key not configured.');
    error.statusCode = 500;
    throw error;
  }

  return Buffer.from(key, 'hex');
}

function decryptSecret(connection) {
  const key = getEncryptionKey();
  const encrypted = Buffer.from(connection.encrypted_restricted_key || '', 'base64');
  const iv = Buffer.from(connection.key_iv || '', 'base64');
  const tag = Buffer.from(connection.key_tag || '', 'base64');

  if (!encrypted.length || !iv.length || !tag.length) {
    const error = new Error('Stored Razorpay secret is incomplete. Reconnect Razorpay.');
    error.statusCode = 400;
    throw error;
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
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
    `select id, organization_id, stripe_account_id, encrypted_restricted_key, key_iv, key_tag, is_active
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
  const webhookSecret = crypto.randomBytes(32).toString('hex');
  const url = `${webhookBaseUrl()}/api/webhooks/razorpay?org=${encodeURIComponent(organizationId)}`;

  const response = await fetch('https://api.razorpay.com/v1/webhooks', {
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

  if (!response.ok) {
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

  const webhookId = cleanString(body.id || body.webhook_id);

  await client.query(
    `update stripe_connections
        set webhook_endpoint_id = $2,
            webhook_secret = $3
      where id = $1`,
    [connection.id, webhookId || null, webhookSecret]
  );

  return {
    webhookRegistered: true,
    webhookId: webhookId || null,
    webhookSecret,
    url,
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
    const organizationId = requireSameOrganization(user, body && body.organizationId);
    const result = await registerRazorpayWebhook({ client, organizationId });

    return sendJson(res, 200, {
      success: true,
      webhookRegistered: result.webhookRegistered,
      webhookId: result.webhookId,
      webhookUrl: result.url,
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
