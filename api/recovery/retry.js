// Revessent /api/recovery/retry
// Attempts a real Razorpay recovery retry for an approved recovery case.
//
// Important Razorpay note:
// This implementation uses a generic Orders + Payment Links approach so a
// failed payment can be retried without requiring subscription-specific API
// assumptions. Before going live, verify the exact retry flow against the
// current Razorpay docs and your product setup. Existing Razorpay subscription
// retries may use different endpoints/payloads than fresh Payment Links.

const { Pool } = require('pg');
const crypto = require('crypto');

const SUPABASE_URL = 'https://zujmouzzqiovgbnanrvv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7JoawOBwMZ-ZIFmDrjkHSA_AdIWlCi3';
const ELIGIBLE_STATUSES = new Set(['detected', 'retrying', 'awaiting_approval']);
const RETRY_DELAY_DAYS = { 1: 1, 2: 3, 3: 7 };

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

function asJson(value) {
  return JSON.stringify(value == null ? {} : value);
}

function toInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
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

async function razorpayRequest(path, keyId, keySecret, payload) {
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: razorpayAuthHeader(keyId, keySecret),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      cleanString(body && body.error && body.error.description) ||
      cleanString(body && body.error && body.error.reason) ||
      cleanString(body && body.message) ||
      `Razorpay API request failed with status ${response.status}.`;

    const error = new Error(message);
    error.statusCode = response.status;
    error.razorpayBody = body;
    throw error;
  }

  return body;
}

function memberContact(member) {
  const metadata = member && member.metadata && typeof member.metadata === 'object' ? member.metadata : {};
  return cleanString(metadata.contact || metadata.phone || metadata.mobile || member.phone || member.contact);
}

async function createRazorpayRetry(caseRow, member, connection, keySecret, reservation) {
  const keyId = cleanString(connection.stripe_account_id);
  const amountCents = toInt(caseRow.amount_cents, 0);
  const currency = cleanString(caseRow.currency || 'INR').toUpperCase();
  const retryAttempt = reservation && reservation.retryCount ? reservation.retryCount : toInt(caseRow.retry_count, 0) + 1;
  const receipt = `rv_${String(caseRow.id).replace(/-/g, '').slice(0, 24)}_${retryAttempt}`;
  const notes = {
    source: 'revessent_retry',
    organization_id: String(caseRow.organization_id),
    recovery_case_id: String(caseRow.id),
    member_id: caseRow.member_id ? String(caseRow.member_id) : '',
    original_payment_id: cleanString(caseRow.stripe_invoice_id || caseRow.stripe_charge_id),
    razorpay_customer_id: cleanString(member && member.stripe_customer_id),
    idempotency_key: reservation && reservation.idempotencyKey ? reservation.idempotencyKey : '',
    retry_attempt: retryAttempt,
  };

  const order = await razorpayRequest('/orders', keyId, keySecret, {
    amount: amountCents,
    currency,
    receipt,
    notes,
  });

  const customer = {};
  if (cleanString(member && member.name)) customer.name = cleanString(member.name);
  if (cleanString(member && member.email)) customer.email = cleanString(member.email);
  if (memberContact(member)) customer.contact = memberContact(member);

  const paymentLinkPayload = {
    amount: amountCents,
    currency,
    accept_partial: false,
    description: `Payment update for your ${currency} subscription`,
    reference_id: receipt,
    notes: { ...notes, razorpay_order_id: order.id || '' },
    callback_method: 'get',
  };

  if (Object.keys(customer).length) paymentLinkPayload.customer = customer;
  if (customer.email || customer.contact) {
    paymentLinkPayload.notify = { email: Boolean(customer.email), sms: Boolean(customer.contact) };
  }

  const paymentLink = await razorpayRequest('/payment_links', keyId, keySecret, paymentLinkPayload);

  return {
    order,
    paymentLink,
    externalId: cleanString(paymentLink.id || order.id),
    checkoutUrl: cleanString(paymentLink.short_url || paymentLink.payment_url || paymentLink.url),
  };
}

function parseRazorpayError(error) {
  const body = error && error.razorpayBody ? error.razorpayBody : {};
  const apiError = body && body.error ? body.error : {};

  return {
    code: cleanString(apiError.code || apiError.reason || error.statusCode || 'razorpay_error'),
    message: cleanString(apiError.description || apiError.message || error.message || 'Razorpay retry failed.'),
    raw: body,
  };
}

function nextRetryDelayDays(retryCount) {
  return RETRY_DELAY_DAYS[retryCount] || RETRY_DELAY_DAYS[3];
}

async function insertActivity(client, values) {
  await client.query(
    `insert into activity_feed
       (id, organization_id, type, title, description, amount_cents, currency, member_id, case_id, metadata, created_at)
     values
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now())`,
    [
      crypto.randomUUID(),
      values.organizationId,
      values.type,
      values.title,
      values.description || null,
      values.amountCents == null ? null : values.amountCents,
      values.currency || null,
      values.memberId || null,
      values.caseId || null,
      asJson(values.metadata || {}),
    ]
  );
}

async function findRecentPendingRetry(client, caseId) {
  const result = await client.query(
    `select id, idempotency_key, created_at
       from recovery_attempts
      where case_id = $1
        and status = 'pending'
        and created_at >= now() - interval '2 minutes'
      order by created_at desc
      limit 1`,
    [caseId]
  );

  return result.rows[0] || null;
}

async function reserveRetryAttempt(client, caseRow) {
  const organizationId = caseRow.organization_id;
  const caseId = caseRow.id;
  const retryCount = toInt(caseRow.retry_count, 0) + 1;
  const maxRetries = Math.max(1, toInt(caseRow.max_retries, 3));
  const attemptId = crypto.randomUUID();
  const idempotencyKey = `rv:${organizationId}:${caseId}:${retryCount}`;

  try {
    await client.query(
      `insert into recovery_attempts
         (id, case_id, organization_id, type, status, idempotency_key, executed_at, created_at)
       values
         ($1, $2, $3, 'retry', 'pending', $4, now(), now())`,
      [attemptId, caseId, organizationId, idempotencyKey]
    );
  } catch (error) {
    if (error && error.code === '23505') {
      const conflict = new Error('A retry is already in progress for this case.');
      conflict.statusCode = 409;
      throw conflict;
    }
    throw error;
  }

  return { attemptId, idempotencyKey, retryCount, maxRetries };
}

async function writeRetryResult(client, caseRow, reservation, razorpayResult, razorpayError) {
  const organizationId = caseRow.organization_id;
  const caseId = caseRow.id;
  const attemptId = reservation.attemptId;
  const retryCount = reservation.retryCount;
  const maxRetries = reservation.maxRetries;

  await client.query('BEGIN');

  try {
    if (razorpayResult) {
      await client.query(
        `update recovery_attempts
            set status = 'success',
                stripe_charge_id = $2,
                executed_at = now()
          where id = $1`,
        [attemptId, razorpayResult.externalId]
      );

      await client.query(
        `update recovery_cases
            set status = 'retrying',
                retry_count = $2,
                next_retry_at = now() + ($3::text || ' days')::interval,
                updated_at = now()
          where id = $1`,
        [caseId, retryCount, nextRetryDelayDays(retryCount)]
      );

      await insertActivity(client, {
        organizationId,
        type: 'note_sent',
        title: 'Payment retry started',
        description: razorpayResult.checkoutUrl
          ? 'A secure Razorpay payment link was created for the customer.'
          : 'A Razorpay retry order was created.',
        amountCents: caseRow.amount_cents,
        currency: caseRow.currency,
        memberId: caseRow.member_id,
        caseId,
        metadata: {
          source: 'manual_retry',
          attempt_id: attemptId,
          idempotency_key: reservation.idempotencyKey,
          razorpay_order_id: razorpayResult.order && razorpayResult.order.id,
          razorpay_payment_link_id: razorpayResult.paymentLink && razorpayResult.paymentLink.id,
          checkout_url: razorpayResult.checkoutUrl,
        },
      });

      await client.query('COMMIT');
      return { newStatus: 'retrying', retryCount };
    }

    const failure = parseRazorpayError(razorpayError);
    const shouldMarkLost = retryCount >= maxRetries;

    await client.query(
      `update recovery_attempts
          set status = 'failed',
              error_code = $2,
              error_message = $3,
              executed_at = now()
        where id = $1`,
      [attemptId, failure.code, failure.message]
    );

    if (shouldMarkLost) {
      await client.query(
        `update recovery_cases
            set status = 'lost',
                retry_count = $2,
                lost_at = now(),
                updated_at = now()
          where id = $1`,
        [caseId, retryCount]
      );

      await insertActivity(client, {
        organizationId,
        type: 'lost',
        title: 'Recovery marked lost',
        description: failure.message,
        amountCents: caseRow.amount_cents,
        currency: caseRow.currency,
        memberId: caseRow.member_id,
        caseId,
        metadata: { source: 'manual_retry', attempt_id: attemptId, idempotency_key: reservation.idempotencyKey, error: failure.raw },
      });
    } else {
      await client.query(
        `update recovery_cases
            set retry_count = $2,
                next_retry_at = now() + ($3::text || ' days')::interval,
                updated_at = now()
          where id = $1`,
        [caseId, retryCount, nextRetryDelayDays(retryCount)]
      );
    }

    await client.query('COMMIT');
    return { newStatus: shouldMarkLost ? 'lost' : caseRow.status, retryCount, error: failure.message };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Revessent retry rollback failed:', rollbackError);
    }
    throw error;
  }
}

module.exports = async (req, res) => {
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

  const caseId = cleanString(body && body.caseId);
  if (!caseId) return sendJson(res, 400, { error: 'caseId is required.' });

  try {
    client = await pool.connect();
    const { user } = await authenticateRequest(req, client);
    const organizationId = user.organization_id;

    const caseResult = await client.query(
      `select *
         from recovery_cases
        where id = $1
        limit 1`,
      [caseId]
    );
    const caseRow = caseResult.rows[0] || null;

    if (!caseRow) return sendJson(res, 404, { error: 'Recovery case not found.' });
    if (String(caseRow.organization_id) !== String(organizationId)) {
      return sendJson(res, 403, { error: 'You do not have access to this recovery case.' });
    }
    if (!ELIGIBLE_STATUSES.has(caseRow.status)) {
      return sendJson(res, 400, { error: 'Case is not eligible for retry.' });
    }

    const pendingAttempt = await findRecentPendingRetry(client, caseId);
    if (pendingAttempt) {
      return sendJson(res, 409, { error: 'A retry is already in progress for this case.' });
    }

    const connectionResult = await client.query(
      `select id, organization_id, stripe_account_id, encrypted_restricted_key, key_iv, key_tag, is_active
         from stripe_connections
        where organization_id = $1
          and is_active = true
        order by connected_at desc nulls last
        limit 1`,
      [organizationId]
    );
    const connection = connectionResult.rows[0] || null;

    if (!connection || !connection.is_active) {
      return sendJson(res, 400, { error: 'Connect Razorpay first.' });
    }

    const memberResult = await client.query(
      `select *
         from stripe_members
        where id = $1
          and organization_id = $2
        limit 1`,
      [caseRow.member_id, organizationId]
    );
    const member = memberResult.rows[0] || null;

    if (!member) return sendJson(res, 404, { error: 'Customer record not found for this recovery case.' });

    const keySecret = decryptSecret(connection);
    const reservation = await reserveRetryAttempt(client, caseRow);

    let razorpayResult = null;
    let razorpayError = null;

    try {
      razorpayResult = await createRazorpayRetry(caseRow, member, connection, keySecret, reservation);
    } catch (error) {
      razorpayError = error;
    }

    const written = await writeRetryResult(client, caseRow, reservation, razorpayResult, razorpayError);

    if (!razorpayResult) {
      return sendJson(res, 502, {
        success: false,
        error: written.error || 'Razorpay retry failed.',
        newStatus: written.newStatus,
        retryCount: written.retryCount,
      });
    }

    return sendJson(res, 200, {
      success: true,
      newStatus: written.newStatus,
      retryCount: written.retryCount,
      orderId: razorpayResult.order && razorpayResult.order.id,
      paymentLinkId: razorpayResult.paymentLink && razorpayResult.paymentLink.id,
      checkoutUrl: razorpayResult.checkoutUrl || null,
    });
  } catch (error) {
    if (error.statusCode && [400, 401, 403, 404, 409].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }

    console.error('Revessent /api/recovery/retry failed:', error);
    return sendJson(res, 500, { error: 'Could not retry this recovery case.' });
  } finally {
    if (client) client.release();
  }
};
