// Revessent /api/razorpay/backfill
// 90-day historical scan of a newly connected Razorpay account.
//
// When a user connects Razorpay, instead of starting from zero we immediately
// pull their last 90 days of payments from Razorpay's Payments API and create
// recovery cases for the failed ones ("look how much you've been losing"),
// with failed_at set to the real historical timestamp so the dashboard's
// weekly chart stays accurate.
//
// This file is both an HTTP endpoint (POST /api/razorpay/backfill) and an
// internal helper: api/razorpay/connect.js imports backfillRazorpayHistory()
// and calls it as a best-effort extra step after registerRazorpayWebhook()
// succeeds. Backfill failures are logged, never fatal — the live webhook is
// the important thing; the historical scan is a nice-to-have.

const { Pool } = require('pg');
const crypto = require('crypto');

const SUPABASE_URL = 'https://zujmouzzqiovgbnanrvv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7JoawOBwMZ-ZIFmDrjkHSA_AdIWlCi3';

// Backfill scan window.
const BACKFILL_WINDOW_DAYS = 90;
// Razorpay's Payments API paginates at 100 records per page.
const RAZORPAY_PAGE_SIZE = 100;
// SAFETY CAP: stop paginating after 20 pages (2,000 payments). Without a cap,
// a runaway loop on a very high-volume account could keep this serverless
// function alive well past its timeout while holding a database connection.
// 2,000 payments inside a 90-day window is far beyond a typical failed-payment
// backlog, so the cap is effectively invisible for normal accounts.
const RAZORPAY_MAX_PAGES = 20;

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

function safeString(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeCurrency(value) {
  return safeString(value || 'INR').toUpperCase();
}

function asJson(value) {
  return JSON.stringify(value == null ? {} : value);
}

function toInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

// ─── Razorpay credential decryption ───────────────────────────────────────────
// Keep in sync with the identical decryptSecret()/getEncryptionKey() helpers in
// api/recovery/retry.js and api/razorpay/connect.js (the exact pattern this
// file was asked to reuse from api/recovery/retry.js).

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

// ─── Decline-reason-specific retry timing ─────────────────────────────────────
// Keep in sync with the identical copies of getRetrySchedule() in:
//   - api/webhooks/razorpay.js
//   - api/recovery/retry.js
// (The function is duplicated verbatim because each api/ file is a standalone
// serverless function in this repo and cannot easily share a module.
// api/cron/process-recovery-queue.js does NOT carry its own copy — it imports
// getRetrySchedule from api/recovery/retry.js, which is the exported source of
// truth.)
//
// Reasoning:
// - expired_card / invalid_account / lost_card / stolen_card / pickup_card:
//   the card itself is bad, so retrying the same card number can NEVER
//   succeed. No automatic retry is scheduled at all (next_retry_at stays
//   null) and the case is created as 'awaiting_approval' — what's needed is
//   a NEW payment method from the customer, not a retry.
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

// ─── Razorpay payment → member / decline code mapping ─────────────────────────
// Keep in sync with the identical helpers in api/webhooks/razorpay.js
// (mapDeclineCode, getNested, extractCustomerId, extractEmail, extractName,
// getPaymentNotes, findOrCreateMember) — the same matching logic the live
// payment.failed webhook uses, replicated here for the historical scan.

function getNested(object, path) {
  return path.split('.').reduce((acc, key) => (acc && acc[key] != null ? acc[key] : undefined), object);
}

function mapDeclineCode(payment) {
  const haystack = [
    payment && payment.error_code,
    payment && payment.error_reason,
    payment && payment.error_description,
    payment && payment.error_source,
    payment && payment.error_step,
    payment && payment.status,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/insufficient|not\s+enough|funds/.test(haystack)) return 'insufficient_funds';
  if (/expired/.test(haystack)) return 'expired_card';
  if (/do[_\s-]?not[_\s-]?honou?r|honou?r/.test(haystack)) return 'do_not_honor';
  if (/invalid[_\s-]?(account|card)|incorrect[_\s-]?card|invalid/.test(haystack)) return 'invalid_account';
  if (/lost/.test(haystack)) return 'lost_card';
  if (/stolen/.test(haystack)) return 'stolen_card';
  if (/pickup|pick[_\s-]?up/.test(haystack)) return 'pickup_card';
  if (/processing|processor|gateway|server|timeout|technical/.test(haystack)) return 'processing_error';
  if (/declin|card/.test(haystack)) return 'card_declined';

  return 'unknown';
}

function extractCustomerId(payment) {
  return (
    safeString(payment && payment.customer_id) ||
    safeString(payment && payment.customer) ||
    safeString(payment && payment.contact_id) ||
    safeString(getNested(payment, 'notes.customer_id')) ||
    safeString(getNested(payment, 'notes.razorpay_customer_id'))
  );
}

function extractEmail(payment) {
  return (
    safeString(payment && payment.email) ||
    safeString(getNested(payment, 'customer.email')) ||
    safeString(getNested(payment, 'notes.email')) ||
    safeString(getNested(payment, 'notes.customer_email'))
  ).toLowerCase();
}

function extractName(payment) {
  return (
    safeString(getNested(payment, 'customer.name')) ||
    safeString(getNested(payment, 'notes.name')) ||
    safeString(getNested(payment, 'notes.customer_name')) ||
    safeString(payment && payment.name) ||
    safeString(payment && payment.contact)
  );
}

function getPaymentNotes(payment) {
  return payment && payment.notes && typeof payment.notes === 'object' ? payment.notes : {};
}

async function findOrCreateMember(client, organizationId, payment) {
  const customerId = extractCustomerId(payment);
  const email = extractEmail(payment);
  const name = extractName(payment);
  const metadata = {
    source: 'razorpay',
    payment_id: payment && payment.id ? payment.id : null,
    contact: payment && payment.contact ? payment.contact : null,
    notes: getPaymentNotes(payment),
  };

  let found = null;

  if (customerId) {
    const byCustomer = await client.query(
      `select *
         from stripe_members
        where organization_id = $1
          and stripe_customer_id = $2
        limit 1`,
      [organizationId, customerId]
    );
    found = byCustomer.rows[0] || null;
  }

  if (!found && email) {
    const byEmail = await client.query(
      `select *
         from stripe_members
        where organization_id = $1
          and lower(email) = lower($2)
        limit 1`,
      [organizationId, email]
    );
    found = byEmail.rows[0] || null;
  }

  if (found) {
    const updated = await client.query(
      `update stripe_members
          set stripe_customer_id = coalesce(nullif($2, ''), stripe_customer_id),
              email = coalesce(nullif($3, ''), email),
              name = coalesce(nullif($4, ''), name),
              metadata = coalesce(metadata, '{}'::jsonb) || $5::jsonb,
              updated_at = now()
        where id = $1
      returning *`,
      [found.id, customerId, email, name, asJson(metadata)]
    );
    return updated.rows[0];
  }

  const inserted = await client.query(
    `insert into stripe_members
       (id, organization_id, stripe_customer_id, email, name, metadata, created_at, updated_at)
     values
       ($1, $2, nullif($3, ''), nullif($4, ''), nullif($5, ''), $6::jsonb, now(), now())
     returning *`,
    [crypto.randomUUID(), organizationId, customerId, email, name, asJson(metadata)]
  );

  return inserted.rows[0];
}

// ─── Historical scan ──────────────────────────────────────────────────────────

// Razorpay timestamps (payment.created_at) are unix seconds; tolerate
// milliseconds just in case so historical failed_at is never wrong by ~53k years.
function parseRazorpayTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n > 1e12 ? n : n * 1000);
}

async function fetchRazorpayPayments(keyId, keySecret, fromUnix, toUnix) {
  const payments = [];

  for (let page = 0; page < RAZORPAY_MAX_PAGES; page += 1) {
    const skip = page * RAZORPAY_PAGE_SIZE;
    const url =
      `https://api.razorpay.com/v1/payments?from=${fromUnix}&to=${toUnix}` +
      `&count=${RAZORPAY_PAGE_SIZE}&skip=${skip}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: razorpayAuthHeader(keyId, keySecret) },
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        cleanString(body && body.error && body.error.description) ||
        cleanString(body && body.error && body.error.reason) ||
        cleanString(body && body.message) ||
        `Razorpay payments API request failed with status ${response.status}.`;

      const error = new Error(`Could not scan Razorpay history: ${message}`);
      error.statusCode = 502;
      error.razorpayStatus = response.status;
      error.razorpayBody = body;
      throw error;
    }

    const items = Array.isArray(body && body.items) ? body.items : [];
    payments.push(...items);

    // Last page reached — fewer records than the page size came back.
    if (items.length < RAZORPAY_PAGE_SIZE) break;
  }

  return payments;
}

// Processes one historical failed payment inside its own small transaction, so
// a failure partway through the scan (record 150 of 300) never rolls back the
// records already saved. Returns 'created' or 'skipped'.
async function backfillOneFailedPayment(client, organizationId, payment) {
  await client.query('BEGIN');

  try {
    // a. Skip payments that already have a recovery case (the live webhook may
    //    have created one for recent failures). stripe_invoice_id holds the
    //    Razorpay payment id and has a unique index.
    const existing = await client.query(
      `select id
         from recovery_cases
        where stripe_invoice_id = $1
        limit 1`,
      [payment.id]
    );

    if (existing.rows[0]) {
      await client.query('COMMIT');
      return { action: 'skipped' };
    }

    // b. Find or create the stripe_members row for this customer.
    const member = await findOrCreateMember(client, organizationId, payment);

    // c. Map the Razorpay error fields onto our decline_code enum.
    const declineCode = mapDeclineCode(payment);

    // d. Insert the recovery case. status/next_retry_at follow Feature 1's
    //    decline-aware logic: 'detected' + scheduled retry when the decline is
    //    retryable, 'awaiting_approval' + no next_retry_at when the card
    //    itself is bad. failed_at is the REAL historical failure timestamp so
    //    the dashboard's weekly chart reports the past accurately.
    const scheduleDays = getRetrySchedule(declineCode, 0);
    const caseStatus = scheduleDays == null ? 'awaiting_approval' : 'detected';
    const failedAt = parseRazorpayTimestamp(payment.created_at) || new Date();
    const amountCents = toInt(payment.amount, 0);
    const currency = normalizeCurrency(payment.currency);

    const insertedCase = await client.query(
      `insert into recovery_cases
         (id, organization_id, member_id, subscription_id, stripe_invoice_id, stripe_charge_id,
          status, decline_code, amount_cents, currency, next_retry_at, retry_count, max_retries,
          failed_at, created_at, updated_at)
       values
         ($1, $2, $3, null, $4, null,
          $5, $6, $7, $8,
          case when $9::int is null then null
               else now() + (($9::int)::text || ' days')::interval end,
          0, 3,
          $10, now(), now())
       on conflict (stripe_invoice_id) do nothing
       returning id, amount_cents, currency`,
      [
        crypto.randomUUID(),
        organizationId,
        member.id,
        payment.id,
        caseStatus,
        declineCode,
        amountCents,
        currency,
        scheduleDays,
        failedAt,
      ]
    );

    const recoveryCase = insertedCase.rows[0] || null;

    if (!recoveryCase) {
      // Raced with the live webhook between the check above and the insert.
      await client.query('COMMIT');
      return { action: 'skipped' };
    }

    // e. Log the backfilled event. The 'backfill:' prefix on stripe_event_id
    //    guarantees no collision with a real future webhook event id for the
    //    same payment. processed_at is set immediately — there is no real
    //    webhook payload to dedupe against.
    await client.query(
      `insert into webhook_events
         (id, organization_id, stripe_event_id, event_type, payload, processed_at, created_at)
       values
         ($1, $2, $3, 'backfill.payment.failed', $4::jsonb, now(), now())
       on conflict (stripe_event_id) do nothing`,
      [
        crypto.randomUUID(),
        organizationId,
        `backfill:${payment.id}`,
        asJson({
          source: 'razorpay_backfill',
          event: 'backfill.payment.failed',
          payment_id: payment.id,
          payment,
        }),
      ]
    );

    await client.query('COMMIT');
    return { action: 'created', amountCents: recoveryCase.amount_cents, currency: recoveryCase.currency };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Revessent backfill rollback failed:', rollbackError);
    }
    throw error;
  }
}

// Main entry point — also imported and called by api/razorpay/connect.js right
// after registerRazorpayWebhook() succeeds. Caller supplies a pg client and an
// organization id; failures throw so the caller can decide whether to log only.
async function backfillRazorpayHistory({ client, organizationId }) {
  const orgId = cleanString(organizationId);
  if (!orgId) {
    const error = new Error('organizationId is required.');
    error.statusCode = 400;
    throw error;
  }

  const connection = await loadActiveConnection(client, orgId);
  if (!connection || !connection.is_active) {
    const error = new Error('Connect Razorpay first.');
    error.statusCode = 400;
    throw error;
  }

  const keyId = cleanString(connection.stripe_account_id);
  const keySecret = decryptSecret(connection);

  const toUnix = Math.floor(Date.now() / 1000);
  const fromUnix = toUnix - BACKFILL_WINDOW_DAYS * 24 * 60 * 60;

  // Every payment record checked in the window (all statuses — the failed
  // ones are filtered below).
  const payments = await fetchRazorpayPayments(keyId, keySecret, fromUnix, toUnix);
  const failedPayments = payments.filter(
    (payment) => payment && payment.id && safeString(payment.status).toLowerCase() === 'failed'
  );

  let newCasesCreated = 0;
  let skippedExisting = 0;
  const totalsByCurrency = {};

  for (const payment of failedPayments) {
    try {
      const outcome = await backfillOneFailedPayment(client, orgId, payment);

      if (outcome.action === 'created') {
        newCasesCreated += 1;
        const currency = normalizeCurrency(outcome.currency);
        totalsByCurrency[currency] = (totalsByCurrency[currency] || 0) + toInt(outcome.amountCents, 0);
      } else {
        skippedExisting += 1;
      }
    } catch (recordError) {
      // One bad record must not abort the whole scan — everything already
      // committed stays saved and the scan moves on to the next payment.
      console.error('Revessent backfill skipped a payment after an error:', payment.id, recordError);
    }
  }

  // Bookkeeping: stamp when this org's historical scan completed (column
  // already exists on stripe_connections). Best-effort only.
  try {
    await client.query(
      `update stripe_connections
          set backfill_completed_at = now()
        where id = $1`,
      [connection.id]
    );
  } catch (stampError) {
    console.error('Revessent backfill could not stamp backfill_completed_at:', stampError);
  }

  // Dominant currency across the newly created cases (Razorpay accounts are
  // virtually always single-currency; this just stays correct if not).
  let newCasesCurrency = null;
  let newCasesAmountCents = 0;
  for (const [currency, cents] of Object.entries(totalsByCurrency)) {
    if (cents >= newCasesAmountCents) {
      newCasesCurrency = currency;
      newCasesAmountCents = cents;
    }
  }

  return {
    scannedCount: payments.length,
    newCasesCreated,
    skippedExisting,
    newCasesAmountCents,
    newCasesCurrency,
  };
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let client;

  try {
    client = await pool.connect();
    const { user } = await authenticateRequest(req, client);

    // Safer pattern (same as api/recovery/retry.js): ignore any client-sent
    // organizationId and always scan the authenticated user's own org.
    const organizationId = String(user.organization_id);

    const result = await backfillRazorpayHistory({ client, organizationId });

    return sendJson(res, 200, { success: true, ...result });
  } catch (error) {
    if (error.statusCode && [400, 401, 403, 404].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }

    if (error.statusCode === 502) {
      // Razorpay API failure (bad credentials, rate limit, ...). The Razorpay
      // connection itself is unaffected — report the scan failure clearly.
      return sendJson(res, 502, { error: error.message });
    }

    console.error('Revessent /api/razorpay/backfill failed:', error);
    return sendJson(res, 500, { error: 'Could not scan your Razorpay history.' });
  } finally {
    if (client) client.release();
  }
}

module.exports = handler;
module.exports.backfillRazorpayHistory = backfillRazorpayHistory;
