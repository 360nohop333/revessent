// Revessent /api/settings
// Verifies the caller's Supabase access token, checks organization ownership,
// reads/saves sender settings, and stores Razorpay credentials securely in Neon.

const { Pool } = require('pg');
const crypto = require('crypto');
const { registerRazorpayWebhook } = require('./razorpay/connect');

const SUPABASE_URL = 'https://zujmouzzqiovgbnanrvv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7JoawOBwMZ-ZIFmDrjkHSA_AdIWlCi3';
const ALLOWED_TONES = new Set(['friendly', 'professional', 'empathetic', 'direct']);

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
  const email = (supabaseUser && supabaseUser.email ? String(supabaseUser.email) : '').trim().toLowerCase();

  if (!email) {
    const error = new Error('Supabase user has no email address.');
    error.statusCode = 401;
    throw error;
  }

  return { email };
}

async function findNeonUserByEmail(client, email) {
  const result = await client.query(
    `select id, organization_id, email, role
       from users
      where lower(email) = lower($1)
      limit 1`,
    [email]
  );

  return result.rows[0] || null;
}

async function authenticateRequest(req, client) {
  const token = getBearerToken(req);
  const { email } = await verifySupabaseToken(token);
  const user = await findNeonUserByEmail(client, email);

  if (!user) {
    const error = new Error('No Revessent user found for this Supabase account.');
    error.statusCode = 401;
    throw error;
  }

  return { token, email, user };
}

function normalizeId(value) {
  return value == null ? '' : String(value).trim();
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
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
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
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

function encryptSecret(secret) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

async function handleGet(req, res, client, user) {
  const organizationId = requireSameOrganization(user, req.query && req.query.organizationId);

  const voiceResult = await client.query(
    `select brand_name, sender_name, sender_email, tone_description
       from voice_profiles
      where organization_id = $1
        and is_default = true
      order by updated_at desc nulls last, created_at desc nulls last
      limit 1`,
    [organizationId]
  );

  const connectionResult = await client.query(
    `select stripe_account_id
       from stripe_connections
      where organization_id = $1
        and is_active = true
      order by connected_at desc nulls last
      limit 1`,
    [organizationId]
  );

  const voice = voiceResult.rows[0] || null;
  const connection = connectionResult.rows[0] || null;

  return sendJson(res, 200, {
    brandName: voice ? voice.brand_name || '' : '',
    senderName: voice ? voice.sender_name || '' : '',
    senderEmail: voice ? voice.sender_email || '' : '',
    tone: voice ? voice.tone_description || '' : '',
    razorpayKeyId: connection ? connection.stripe_account_id || null : null,
    razorpayConnected: Boolean(connection),
  });
}

function validatePostBody(body) {
  const organizationId = normalizeId(body.organizationId);
  const brandName = cleanString(body.brandName);
  const senderName = cleanString(body.senderName);
  const senderEmail = cleanString(body.senderEmail);
  const submittedTone = cleanString(body.tone);
  const tone = ALLOWED_TONES.has(submittedTone) ? submittedTone : 'professional';
  const razorpayKeyId = cleanString(body.razorpayKeyId);
  const razorpayKeySecret = cleanString(body.razorpayKeySecret);

  if (!brandName) {
    const error = new Error('Brand name is required.');
    error.statusCode = 400;
    throw error;
  }

  if (!senderName) {
    const error = new Error('Sender name is required.');
    error.statusCode = 400;
    throw error;
  }

  if (!senderEmail) {
    const error = new Error('Sender email is required.');
    error.statusCode = 400;
    throw error;
  }

  if ((razorpayKeyId && !razorpayKeySecret) || (!razorpayKeyId && razorpayKeySecret)) {
    const error = new Error('Enter both the Razorpay Key ID and Key Secret to connect Razorpay.');
    error.statusCode = 400;
    throw error;
  }

  return {
    organizationId,
    brandName,
    senderName,
    senderEmail,
    tone,
    razorpayKeyId,
    razorpayKeySecret,
    shouldUpdateRazorpay: Boolean(razorpayKeyId && razorpayKeySecret),
  };
}

async function upsertVoiceProfile(client, values) {
  const existing = await client.query(
    `select id
       from voice_profiles
      where organization_id = $1
        and is_default = true
      order by updated_at desc nulls last, created_at desc nulls last
      limit 1`,
    [values.organizationId]
  );

  if (existing.rows[0]) {
    await client.query(
      `update voice_profiles
          set brand_name = $1,
              sender_name = $2,
              sender_email = $3,
              tone_description = $4,
              updated_at = now()
        where id = $5`,
      [values.brandName, values.senderName, values.senderEmail, values.tone, existing.rows[0].id]
    );
    return;
  }

  await client.query(
    `insert into voice_profiles
       (id, organization_id, brand_name, sender_name, sender_email, tone_description, is_default, created_at, updated_at)
     values
       ($1, $2, $3, $4, $5, $6, true, now(), now())`,
    [crypto.randomUUID(), values.organizationId, values.brandName, values.senderName, values.senderEmail, values.tone]
  );
}

async function upsertRazorpayConnection(client, values) {
  const encrypted = encryptSecret(values.razorpayKeySecret);

  const existing = await client.query(
    `select id
       from stripe_connections
      where organization_id = $1
      order by connected_at desc nulls last
      limit 1`,
    [values.organizationId]
  );

  if (existing.rows[0]) {
    await client.query(
      `update stripe_connections
          set encrypted_restricted_key = $1,
              key_iv = $2,
              key_tag = $3,
              stripe_account_id = $4,
              is_active = true,
              revoked_at = null,
              connected_at = coalesce(connected_at, now())
        where id = $5`,
      [encrypted.encrypted, encrypted.iv, encrypted.tag, values.razorpayKeyId, existing.rows[0].id]
    );
    return;
  }

  await client.query(
    `insert into stripe_connections
       (id, organization_id, encrypted_restricted_key, key_iv, key_tag, stripe_account_id, is_active, connected_at)
     values
       ($1, $2, $3, $4, $5, $6, true, now())`,
    [crypto.randomUUID(), values.organizationId, encrypted.encrypted, encrypted.iv, encrypted.tag, values.razorpayKeyId]
  );
}

async function handlePost(req, res, client, user) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: 'Invalid JSON body.' });
  }

  const values = validatePostBody(body || {});
  values.organizationId = requireSameOrganization(user, values.organizationId);

  try {
    await client.query('BEGIN');
    await upsertVoiceProfile(client, values);

    if (values.shouldUpdateRazorpay) {
      await upsertRazorpayConnection(client, values);
    }

    await client.query('COMMIT');

    if (values.shouldUpdateRazorpay) {
      try {
        const webhook = await registerRazorpayWebhook({ client, organizationId: values.organizationId });
        return sendJson(res, 200, { success: true, razorpayWebhook: { registered: true, id: webhook.webhookId, url: webhook.url } });
      } catch (webhookError) {
        console.error('Revessent Razorpay webhook registration failed after settings save:', webhookError);
        return sendJson(res, webhookError.statusCode || 502, {
          success: false,
          settingsSaved: true,
          error: webhookError.message || 'Settings were saved, but Razorpay webhook registration failed.',
        });
      }
    }

    return sendJson(res, 200, { success: true });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Revessent settings rollback failed:', rollbackError);
    }

    if (error.statusCode === 500 && error.message === 'Encryption key not configured.') {
      return sendJson(res, 500, { error: 'Encryption key not configured.' });
    }

    console.error('Revessent /api/settings write failed:', error);
    return sendJson(res, 500, { error: 'Could not save settings.' });
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let client;

  try {
    client = await pool.connect();
    const { user } = await authenticateRequest(req, client);

    if (req.method === 'GET') {
      return await handleGet(req, res, client, user);
    }

    return await handlePost(req, res, client, user);
  } catch (error) {
    if (error.statusCode && [400, 401, 403].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }

    console.error('Revessent /api/settings failed:', error);
    return sendJson(res, 500, { error: 'Settings request failed.' });
  } finally {
    if (client) client.release();
  }
};
