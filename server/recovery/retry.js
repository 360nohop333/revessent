// Revessent /api/recovery/retry
// Attempts a real Razorpay recovery retry for an approved recovery case.
//
// This file is both an HTTP endpoint and an internal helper. The core
// "attempt a Razorpay retry and record the result" logic lives in the
// exported performRetryAttempt(client, caseRow, { automatic }) function so the
// hourly escalation cron (api/cron/process-recovery-queue.js) can run retries
// directly without an HTTP round-trip to this endpoint.
//
// Important Razorpay note:
// This implementation uses a generic Orders + Payment Links approach so a
// failed payment can be retried without requiring subscription-specific API
// assumptions. Before going live, verify the exact retry flow against the
// current Razorpay docs and your product setup. Existing Razorpay subscription
// retries may use different endpoints/payloads than fresh Payment Links.

const { Pool } = require('pg');
const crypto = require('crypto');
const { sendAlertIfConfigured } = require('../alerts/send');
const { logAudit } = require('../_lib/audit');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zujmouzzqiovgbnanrvv.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_7JoawOBwMZ-ZIFmDrjkHSA_AdIWlCi3';
const ELIGIBLE_STATUSES = new Set(['detected', 'retrying', 'awaiting_approval']);

// ─── Decline-reason-specific retry timing ─────────────────────────────────────
// Keep in sync with the identical copies of getRetrySchedule() in:
//   - api/webhooks/razorpay.js
//   - api/razorpay/backfill.js
// (The function is duplicated verbatim because each api/ file is a standalone
// serverless function in this repo and cannot easily share a module.
// api/cron/process-recovery-queue.js does NOT carry its own copy — it imports
// getRetrySchedule from this file, which is also the exported source of truth.)
//
// Reasoning:
// - expired_card / invalid_account / lost_card / stolen_card / pickup_card:
//   the card itself is bad, so retrying the same card number can NEVER
//   succeed. No automatic retry is scheduled at all (next_retry_at stays
//   null) — the case is created as 'awaiting_approval' by the webhook and the
//   customer needs to provide a new payment method instead.
// - insufficient_funds: customers often get paid on specific dates (end of
//   month / start of month), so give payday cycles time to pass:
//   attempt 1 at +3 days, attempt 2 at +7 days, attempt 3 at +14 days.
// - card_declined / do_not_honor / processing_error / unknown (and anything
//   unrecognized): generic, often transient bank-side declines, so keep the
//   standard cadence: attempt 1 at +1 day, attempt 2 at +3 days,
//   attempt 3 at +7 days.
//
// retryCount is the number of retry attempts already completed (0 for a
// freshly detected case). Returns the number of days to wait before the NEXT
// retry attempt, or null when the decline code must never be auto-retried.
const NO_AUTO_RETRY_DECLINE_CODES = new Set([
  'expired_card',
  'invalid_account',
  'lost_card',
  'stolen_card',
  'pickup_card',
  'upi_mandate_issue', // UPI mandate/NACH failure — needs customer action, not a retry
]);

const STANDARD_RETRY_SCHEDULE_DAYS = { 1: 1, 2: 3, 3: 7 };
const INSUFFICIENT_FUNDS_RETRY_SCHEDULE_DAYS = { 1: 3, 2: 7, 3: 14 };

function getRetrySchedule(declineCode, retryCount) {
  if (NO_AUTO_RETRY_DECLINE_CODES.has(declineCode)) {
    return null;
  }

  const schedule =
    declineCode === 'insufficient_funds'
      ? INSUFFICIENT_FUNDS_RETRY_SCHEDULE_DAYS
      : STANDARD_RETRY_SCHEDULE_DAYS;

  const attemptsDone = Number(retryCount);
  const nextAttempt = Math.min(
    Math.max(1, (Number.isFinite(attemptsDone) ? Math.round(attemptsDone) : 0) + 1),
    3
  );

  return schedule[nextAttempt] != null ? schedule[nextAttempt] : schedule[3];
}

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
  };

  if (Object.keys(customer).length) paymentLinkPayload.customer = customer;
  // Audit #29: Razorpay's own notify (email/SMS) is deliberately OFF — those
  // messages would bypass the merchant's voice and approval flow. The link is
  // surfaced to the merchant instead, to send inside a Revessent note.
  // callback_method is also omitted: there is no callback_url to call back.
  paymentLinkPayload.notify = { email: false, sms: false };

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

async function writeRetryResult(client, caseRow, reservation, razorpayResult, razorpayError, options = {}) {
  const automatic = Boolean(options.automatic);
  const organizationId = caseRow.organization_id;
  const caseId = caseRow.id;
  const attemptId = reservation.attemptId;
  const retryCount = reservation.retryCount;
  const maxRetries = reservation.maxRetries;

  // Decline-aware wait until the next attempt (Feature 1). null means this
  // decline code is never auto-retried, so next_retry_at is cleared entirely.
  const scheduleDays = getRetrySchedule(caseRow.decline_code, retryCount);

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
                next_retry_at = case when $3::int is null then null
                                     else now() + (($3::int)::text || ' days')::interval end,
                updated_at = now()
          where id = $1`,
        [caseId, retryCount, scheduleDays]
      );

      await insertActivity(client, {
        organizationId,
        type: 'retry',
        title: automatic ? 'Automatic retry attempted' : 'Payment retry started',
        // Audit #33: surface the payment link so the merchant can send it in
        // their own voice (Razorpay notify is off).
        description: razorpayResult.checkoutUrl
          ? 'Secure payment link created (Razorpay notify is off — send this in your own note): ' + razorpayResult.checkoutUrl
          : 'A Razorpay retry order was created.',
        amountCents: caseRow.amount_cents,
        currency: caseRow.currency,
        memberId: caseRow.member_id,
        caseId,
        metadata: {
          source: automatic ? 'automatic_retry' : 'manual_retry',
          automatic,
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
    // Audit #31: only condemn a case to "lost" when Razorpay itself returned
    // an error RESPONSE (the request reached them and was definitively
    // rejected). An infrastructure failure — network timeout, DNS, a 5xx
    // with no body — must never mark a case lost; the customer keeps their
    // place in the queue and the next scheduled run tries again.
    const razorpayResponded = Boolean(
      razorpayError &&
      razorpayError.razorpayBody &&
      Object.keys(razorpayError.razorpayBody).length > 0
    );
    const shouldMarkLost = razorpayResponded && retryCount >= maxRetries;

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
        title: automatic ? 'Recovery automatically marked lost' : 'Recovery marked lost',
        description: failure.message,
        amountCents: caseRow.amount_cents,
        currency: caseRow.currency,
        memberId: caseRow.member_id,
        caseId,
        metadata: {
          source: automatic ? 'automatic_retry' : 'manual_retry',
          automatic,
          attempt_id: attemptId,
          idempotency_key: reservation.idempotencyKey,
          error: failure.raw,
        },
      });
    } else {
      await client.query(
        `update recovery_cases
            set retry_count = $2,
                next_retry_at = case when $3::int is null then null
                                     else now() + (($3::int)::text || ' days')::interval end,
                updated_at = now()
          where id = $1`,
        [caseId, retryCount, scheduleDays]
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

// Core reusable retry logic — shared by the HTTP endpoint below and the hourly
// escalation cron (api/cron/process-recovery-queue.js). Loads the org's Razorpay
// connection and the case's member, reserves the attempt (idempotency), calls
// Razorpay, and records the outcome — including the decline-aware
// next_retry_at scheduling and the max_retries → 'lost' transition.
//
// options.automatic marks the activity-feed entries as cron-triggered
// ("Automatic retry attempted" vs "Payment retry started").
//
// Returns { attempted, ok, newStatus, retryCount, error, orderId,
// paymentLinkId, checkoutUrl }. attempted=false means a retry was already in
// flight for this case and nothing was done. Throws (with statusCode) for
// missing connection/member or infrastructure failures.
async function performRetryAttempt(client, caseRow, options = {}) {
  const automatic = Boolean(options.automatic);

  // Skip if a retry is already in flight (manual click or a previous run).
  const pendingAttempt = await findRecentPendingRetry(client, caseRow.id);
  if (pendingAttempt) {
    return { attempted: false, reason: 'pending', message: 'A retry is already in progress for this case.' };
  }

  const connectionResult = await client.query(
    `select id, organization_id, stripe_account_id, encrypted_restricted_key, key_iv, key_tag, is_active
       from stripe_connections
      where organization_id = $1
        and is_active = true
      order by connected_at desc nulls last
      limit 1`,
    [caseRow.organization_id]
  );
  const connection = connectionResult.rows[0] || null;

  if (!connection || !connection.is_active) {
    const error = new Error('Connect Razorpay first.');
    error.statusCode = 400;
    throw error;
  }

  const memberResult = await client.query(
    `select *
       from stripe_members
      where id = $1
        and organization_id = $2
      limit 1`,
    [caseRow.member_id, caseRow.organization_id]
  );
  const member = memberResult.rows[0] || null;

  if (!member) {
    const error = new Error('Customer record not found for this recovery case.');
    error.statusCode = 404;
    throw error;
  }

  const keySecret = decryptSecret(connection);
  const reservation = await reserveRetryAttempt(client, caseRow);

  let razorpayResult = null;
  let razorpayError = null;

  try {
    razorpayResult = await createRazorpayRetry(caseRow, member, connection, keySecret, reservation);
  } catch (error) {
    razorpayError = error;
  }

  const written = await writeRetryResult(client, caseRow, reservation, razorpayResult, razorpayError, { automatic });

  return {
    attempted: true,
    ok: Boolean(razorpayResult),
    newStatus: written.newStatus,
    retryCount: written.retryCount,
    error: written.error || null,
    orderId: razorpayResult && razorpayResult.order ? razorpayResult.order.id : null,
    paymentLinkId: razorpayResult && razorpayResult.paymentLink ? razorpayResult.paymentLink.id : null,
    checkoutUrl: razorpayResult ? razorpayResult.checkoutUrl || null : null,
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

  const caseId = cleanString(body && body.caseId);
  if (!caseId) return sendJson(res, 400, { error: 'caseId is required.' });

  try {
    client = await pool.connect();
    const { user } = await authenticateRequest(req, client);
    // Audit #4: role check — only owners/admins may perform this action.
    if (!['owner', 'admin'].includes(String((user && user.role) || '').toLowerCase())) {
      return sendJson(res, 403, { error: 'Only workspace owners or admins can perform this action.' });
    }

    const organizationId = user.organization_id;

    const auditCtx = { organizationId, userId: user.id, action: 'case.retry', detail: { caseId } };

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

    const result = await performRetryAttempt(client, caseRow);

    // Alert hook (Feature 12): a retry attempt initiated from this endpoint
    // never itself resolves a case to 'recovered' today — capture arrives via
    // the payment.captured webhook, which fires the "💰 Payment recovered"
    // alert on its own. This guard keeps this endpoint wired to the alert in
    // case a retry path ever marks a case recovered directly.
    // sendAlertIfConfigured never throws and quietly does nothing when the org
    // has no alert webhook configured.
    if (result.attempted) {
      await logAudit(client, auditCtx);
    }

    if (result.attempted && result.newStatus === 'recovered') {
      await sendAlertIfConfigured(client, caseRow.organization_id, {
        title: '💰 Payment recovered',
        amountCents: caseRow.amount_cents,
        currency: caseRow.currency,
      });
    }

    if (!result.attempted) {
      return sendJson(res, 409, { error: result.message });
    }

    if (!result.ok) {
      return sendJson(res, 502, {
        success: false,
        error: result.error || 'Razorpay retry failed.',
        newStatus: result.newStatus,
        retryCount: result.retryCount,
      });
    }

    return sendJson(res, 200, {
      success: true,
      newStatus: result.newStatus,
      retryCount: result.retryCount,
      orderId: result.orderId,
      paymentLinkId: result.paymentLinkId,
      checkoutUrl: result.checkoutUrl,
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
}

module.exports = handler;
module.exports.performRetryAttempt = performRetryAttempt;
module.exports.getRetrySchedule = getRetrySchedule;
