// Revessent /api/webhooks/razorpay
// Receives Razorpay webhook events for one Revessent organization, verifies
// Razorpay's HMAC signature, logs the raw event, and creates/updates recovery
// cases for failed/captured payments.
//
// Razorpay payload shape assumptions used here:
// - Webhook body is JSON like:
//   { entity, account_id, event, contains, payload: { payment: { entity: {...} } } }
// - Event type is payload.event, e.g. "payment.failed" or "payment.captured".
// - Payment fields are read from payload.payload.payment.entity.
// - Razorpay's exact field names may vary by API version and webhook product;
//   double-check current Razorpay docs when wiring/registering the webhook.
// - Webhook URL must include ?org=<organization_id>, so we can look up that
//   organization's stored Razorpay webhook_secret before verifying signature.

const { Pool } = require('pg');
const crypto = require('crypto');
const { sendAlertIfConfigured } = require('../alerts/send');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1, // audit #45: single connection per serverless instance
  ssl: { rejectUnauthorized: false },
});

const OPEN_CASE_STATUSES = [
  'detected',
  'retrying',
  'awaiting_approval',
  'note_sent',
  'checkout_sent',
];

// Hardcoded default for "notably large" failed payments (> 10000 cents / $100)
// that trigger a "⚠️ High-value payment failed" alert. Deliberately separate
// from the user-configurable organizations.alert_min_amount_cents, which gates
// the "💰 Payment recovered" alerts.
const HIGH_VALUE_FAILED_ALERT_CENTS = 10000;

// ─── Decline-reason-specific retry timing ─────────────────────────────────────
// Keep in sync with the identical copies of getRetrySchedule() in:
//   - api/recovery/retry.js
//   - api/razorpay/backfill.js
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
//   null) and the case goes straight to 'awaiting_approval' — what's needed
//   is a NEW payment method from the customer, not a retry.
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

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function getQueryParam(req, key) {
  if (req.query && req.query[key] != null) return String(req.query[key]);

  try {
    const url = new URL(req.url, 'https://revessent.local');
    return url.searchParams.get(key) || '';
  } catch (_) {
    return '';
  }
}

async function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;

  if (typeof req.body === 'string') {
    return Buffer.from(req.body, 'utf8');
  }

  // Fallback for environments that already parsed the body. Signature checks
  // require exact raw bytes, so the manual stream path above is preferred.
  if (req.body && typeof req.body === 'object') {
    return Buffer.from(JSON.stringify(req.body), 'utf8');
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function safeString(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeCurrency(value) {
  return safeString(value || 'INR').toUpperCase();
}

function toInteger(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function asJson(value) {
  return JSON.stringify(value == null ? {} : value);
}

function verifyRazorpaySignature(rawBody, webhookSecret, signatureHeader) {
  const signature = safeString(signatureHeader);
  if (!signature || !webhookSecret) return false;

  const expectedHex = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

  let expected;
  let actual;

  try {
    expected = Buffer.from(expectedHex, 'hex');
    actual = Buffer.from(signature, 'hex');
  } catch (_) {
    return false;
  }

  if (expected.length === 0 || actual.length === 0 || expected.length !== actual.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, actual);
}

async function getWebhookSecretForOrg(client, organizationId) {
  const result = await client.query(
    `select organization_id, webhook_secret
       from stripe_connections
      where organization_id = $1
        and is_active = true
        and webhook_secret is not null
      order by connected_at desc nulls last
      limit 1`,
    [organizationId]
  );

  return result.rows[0] || null;
}

function getPaymentEntity(eventPayload) {
  return (
    eventPayload &&
    eventPayload.payload &&
    eventPayload.payload.payment &&
    eventPayload.payload.payment.entity
  ) || null;
}

function getNested(object, path) {
  return path.split('.').reduce((acc, key) => (acc && acc[key] != null ? acc[key] : undefined), object);
}

function eventFingerprint(eventPayload, rawBody) {
  const eventType = safeString(eventPayload && eventPayload.event) || 'unknown';
  const payment = getPaymentEntity(eventPayload);
  const topLevelId =
    safeString(eventPayload && eventPayload.id) ||
    safeString(eventPayload && eventPayload.event_id) ||
    safeString(eventPayload && eventPayload.entity_id);

  if (topLevelId) return topLevelId;
  if (payment && payment.id) return `${eventType}:${payment.id}`;

  return `${eventType}:${crypto.createHash('sha256').update(rawBody).digest('hex')}`;
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

  if (/insufficient|not\s+enough|funds/.test(haystack)) return 'insufficient_funds';  if (/upi[^a-z]*(limit|cap)|per[_\s-]?transaction[_\s-]?limit|limit[_\s-]?exceeded/.test(haystack)) return 'insufficient_funds';
  if (/mandate|autopa?se|nach[_\s-]?(debit|failure|reject)/.test(haystack)) return 'upi_mandate_issue';

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

// Audit #39: Razorpay sometimes puts the customer's phone number in the
// name field. Never store a "+91…" string as a person's name.
function cleanName(value) {
  return safeString(value).replace(/\s+/g, ' ').trim().slice(0, 120);
}
function isPhoneLike(value) {
  const text = cleanName(value);
  return text.length >= 7 && /^[+()\d\s.\-]+$/.test(text) && /\d/.test(text);
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

function extractSubscriptionId(payment) {
  return (
    safeString(payment && payment.subscription_id) ||
    safeString(getNested(payment, 'notes.subscription_id')) ||
    safeString(getNested(payment, 'notes.razorpay_subscription_id'))
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
              name = case when $4 = '' then name else $4 end,
              metadata = coalesce(metadata, '{}'::jsonb) || $5::jsonb,
              updated_at = now()
        where id = $1
        returning *`,
      [found.id, customerId, email, isPhoneLike(name) ? '' : name, asJson(metadata)]
    );
    return updated.rows[0];
  }

  const inserted = await client.query(
    `insert into stripe_members
       (id, organization_id, stripe_customer_id, email, name, metadata, created_at, updated_at)
     values
       ($1, $2, nullif($3, ''), nullif($4, ''), nullif($5, ''), $6::jsonb, now(), now())
     returning *`,
    [crypto.randomUUID(), organizationId, customerId, email, isPhoneLike(name) ? '' : name, asJson(metadata)]
  );

  return inserted.rows[0];
}

async function findSubscription(client, organizationId, razorpaySubscriptionId) {
  if (!razorpaySubscriptionId) return null;

  const result = await client.query(
    `select id, member_id
       from stripe_subscriptions
      where organization_id = $1
        and stripe_subscription_id = $2
      limit 1`,
    [organizationId, razorpaySubscriptionId]
  );

  return result.rows[0] || null;
}

// Audit #23 (light): keep stripe_subscriptions in sync from payment events —
// captured → active, failed → past_due. Full backfill remains on the roadmap.
async function upsertSubscriptionFromPayment(client, organizationId, memberId, subscriptionId, status, amountCents, currency) {
  if (!subscriptionId || !memberId) return;
  try {
    await client.query(
      `insert into stripe_subscriptions
         (id, organization_id, member_id, stripe_subscription_id, status, amount_cents, currency, current_period_start, created_at, updated_at)
       values
         ($1, $2, $3, $4, $5, nullif($6, 0), $7, now(), now(), now())
       on conflict (organization_id, stripe_subscription_id) do update
         set status = excluded.status,
             amount_cents = coalesce(nullif(excluded.amount_cents, 0), stripe_subscriptions.amount_cents),
             currency = excluded.currency,
             current_period_start = now(),
             updated_at = now()`,
      [crypto.randomUUID(), organizationId, memberId, subscriptionId, status, amountCents, currency]
    );
  } catch (error) {
    console.error('Revessent webhook: subscription upsert failed:', error);
  }
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

async function handlePaymentFailed(client, organizationId, eventPayload) {
  const payment = getPaymentEntity(eventPayload);
  if (!payment || !payment.id) {
    throw new Error('payment.failed payload missing payment.entity.id.');
  }

  const amountCents = toInteger(payment.amount, 0);
  const currency = normalizeCurrency(payment.currency);
  const declineCode = mapDeclineCode(payment);
  const member = await findOrCreateMember(client, organizationId, payment);
  const subscriptionId = extractSubscriptionId(payment);
  const subscription = await findSubscription(client, organizationId, subscriptionId);
  await upsertSubscriptionFromPayment(client, organizationId, member.id, subscriptionId, 'past_due', amountCents, currency);

  // Decline-aware initial retry scheduling (Feature 1):
  // - Non-retryable decline codes (bad card) → no next_retry_at at all and the
  //   case starts as 'awaiting_approval', since what's needed is a new payment
  //   method from the customer, not an automatic retry of the same card.
  // - insufficient_funds → first attempt at +3 days (payday-cycle aware).
  // - Generic/transient declines → first attempt at +1 day (standard cadence).
  const initialRetryDelayDays = getRetrySchedule(declineCode, 0);
  const initialStatus = initialRetryDelayDays == null ? 'awaiting_approval' : 'detected';

  const insertedCase = await client.query(
    `insert into recovery_cases
       (id, organization_id, member_id, subscription_id, stripe_invoice_id, stripe_charge_id,
        status, decline_code, amount_cents, currency, next_retry_at, retry_count, max_retries,
        failed_at, created_at, updated_at)
     values
       ($1, $2, $3, $4, $5, null,
        $6, $7, $8, $9,
        case when $10::int is null then null
             else now() + (($10::int)::text || ' days')::interval end,
        0, 3,
        now(), now(), now())
     on conflict (stripe_invoice_id) do nothing
     returning id`,
    [
      crypto.randomUUID(),
      organizationId,
      member.id,
      subscription ? subscription.id : null,
      payment.id,
      initialStatus,
      declineCode,
      amountCents,
      currency,
      initialRetryDelayDays,
    ]
  );

  const recoveryCase = insertedCase.rows[0] || null;

  if (!recoveryCase) {
    return { action: 'case_duplicate', paymentId: payment.id };
  }

  await insertActivity(client, {
    organizationId,
    type: 'detected',
    title: 'Payment failed',
    description: payment.error_description || payment.error_reason || 'Razorpay reported a failed payment.',
    amountCents,
    currency,
    memberId: member.id,
    caseId: recoveryCase.id,
    metadata: {
      source: 'razorpay_webhook',
      event: eventPayload.event,
      payment_id: payment.id,
      decline_code: declineCode,
      auto_retry: initialRetryDelayDays != null,
      next_retry_in_days: initialRetryDelayDays,
    },
  });

  // Ask the handler (after COMMIT) to fire a Slack/Discord alert for notably
  // large failures. Returned rather than sent inline so a slow webhook call
  // can never hold open — or roll back — the case-writing transaction.
  const result = { action: 'case_created', caseId: recoveryCase.id, paymentId: payment.id };
  if (amountCents > HIGH_VALUE_FAILED_ALERT_CENTS) {
    result.alert = { title: '⚠️ High-value payment failed', amountCents, currency };
  }

  return result;
}

function amountLabel(amountCents, currency) {
  const amount = (Number(amountCents || 0) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return `${currency || 'INR'} ${amount}`;
}

function recoveryCaseCandidateIds(payment) {
  const notes = getPaymentNotes(payment);
  return [
    safeString(notes.recovery_case_id),
    safeString(notes.revessent_case_id),
  ].filter(Boolean);
}

function failedPaymentCandidateIds(payment) {
  const notes = getPaymentNotes(payment);
  return [
    safeString(notes.original_payment_id),
    safeString(notes.failed_payment_id),
    safeString(notes.revessent_failed_payment_id),
    safeString(payment && payment.order_id),
    safeString(payment && payment.invoice_id),
    safeString(payment && payment.id),
  ].filter(Boolean);
}

async function findOpenRecoveryCaseForCapturedPayment(client, organizationId, payment) {
  const caseIds = recoveryCaseCandidateIds(payment);
  const paymentIds = failedPaymentCandidateIds(payment);

  if (caseIds.length) {
    const byCaseId = await client.query(
      `select id, member_id, amount_cents, currency
         from recovery_cases
        where organization_id = $1
          and id = any($2::uuid[])
          and status = any($3::text[])
        order by created_at desc
        limit 1`,
      [organizationId, caseIds, OPEN_CASE_STATUSES]
    );
    if (byCaseId.rows[0]) return byCaseId.rows[0];
  }

  if (paymentIds.length) {
    const byPaymentId = await client.query(
      `select id, member_id, amount_cents, currency
         from recovery_cases
        where organization_id = $1
          and stripe_invoice_id = any($2::text[])
          and status = any($3::text[])
        order by created_at desc
        limit 1`,
      [organizationId, paymentIds, OPEN_CASE_STATUSES]
    );
    if (byPaymentId.rows[0]) return byPaymentId.rows[0];
  }

  const subscriptionId = extractSubscriptionId(payment);
  const amountCents = toInteger(payment && payment.amount, 0);

  if (subscriptionId && amountCents > 0) {
    const bySubscription = await client.query(
      `select rc.id, rc.member_id, rc.amount_cents, rc.currency
         from recovery_cases rc
         join stripe_subscriptions ss on ss.id = rc.subscription_id
        where rc.organization_id = $1
          and ss.stripe_subscription_id = $2
          and rc.amount_cents = $3
          and rc.status = any($4::text[])
        order by rc.created_at desc
        limit 1`,
      [organizationId, subscriptionId, amountCents, OPEN_CASE_STATUSES]
    );
    if (bySubscription.rows[0]) return bySubscription.rows[0];
  }

  return null;
}

async function handlePaymentCaptured(client, organizationId, eventPayload) {
  const payment = getPaymentEntity(eventPayload);
  if (!payment || !payment.id) {
    throw new Error('payment.captured payload missing payment.entity.id.');
  }

  const recoveryCase = await findOpenRecoveryCaseForCapturedPayment(client, organizationId, payment);

  if (!recoveryCase) {
    return { action: 'fresh_success_ignored', paymentId: payment.id };
  }

  const amountCents = toInteger(payment.amount, recoveryCase.amount_cents || 0);
  const currency = normalizeCurrency(payment.currency || recoveryCase.currency);
  await upsertSubscriptionFromPayment(client, organizationId, recoveryCase.member_id, extractSubscriptionId(payment), 'active', amountCents, currency);

  await client.query(
    `update recovery_cases
        set status = 'recovered',
            recovered_at = now(),
            recovery_source = 'retry',
            updated_at = now()
      where id = $1`,
    [recoveryCase.id]
  );

  // Audit #22: write the attribution ledger row — this is what "revenue
  // recovered" on the dashboard, the CSV exports and outcome pricing all
  // read from. Guarded with not-exists so a replayed event can never
  // double-count the same case.
  await client.query(
    `insert into recovery_attributions
       (id, organization_id, case_id, member_id, source, amount_cents, currency, recovered_at, attribution_window_days)
     select $1, $2, $3, $4, 'retry', $5, $6, now(), 90
      where not exists (
        select 1 from recovery_attributions where case_id = $3
      )`,
    [crypto.randomUUID(), organizationId, recoveryCase.id, recoveryCase.member_id, amountCents, currency]
  );

  await insertActivity(client, {
    organizationId,
    type: 'recovered',
    title: `${amountLabel(amountCents, currency)} recovered`,
    description: 'Payment captured by Razorpay after a recovery attempt.',
    amountCents,
    currency,
    memberId: recoveryCase.member_id,
    caseId: recoveryCase.id,
    metadata: {
      source: 'razorpay_webhook',
      event: eventPayload.event,
      payment_id: payment.id,
    },
  });

  // Ask the handler (after COMMIT) to fire the "💰 Payment recovered"
  // Slack/Discord alert. Returned rather than sent inline so a slow webhook
  // call can never hold open — or roll back — the recovery transaction.
  return {
    action: 'case_recovered',
    caseId: recoveryCase.id,
    paymentId: payment.id,
    alert: { title: '💰 Payment recovered', amountCents, currency },
  };
}

async function processEvent(client, organizationId, eventPayload) {
  const eventType = safeString(eventPayload && eventPayload.event);

  if (eventType === 'payment.failed') {
    return await handlePaymentFailed(client, organizationId, eventPayload);
  }

  if (eventType === 'payment.captured') {
    return await handlePaymentCaptured(client, organizationId, eventPayload);
  }

  return { action: 'ignored', eventType };
}

async function logWebhookEvent(client, organizationId, eventId, eventType, eventPayload) {
  const result = await client.query(
    `insert into webhook_events
       (id, organization_id, stripe_event_id, event_type, payload, created_at)
     values
       ($1, $2, $3, $4, $5::jsonb, now())
     on conflict (stripe_event_id) do nothing
     returning id`,
    [crypto.randomUUID(), organizationId, eventId, eventType, asJson(eventPayload)]
  );

  if (result.rows[0]) {
    return { id: result.rows[0].id, alreadyProcessed: false };
  }

  // Audit #20: we've seen this event id before. If the previous attempt
  // ERRORED, hand it back for reprocessing so Razorpay's retries (and manual
  // replays) get a real chance; only cleanly-processed events stay deduped.
  const existing = await client.query(
    `select id, processed_at, processing_error
       from webhook_events
      where stripe_event_id = $1
      limit 1`,
    [eventId]
  );
  const row = existing.rows[0] || null;
  if (!row) return null;
  if (row.processed_at && !row.processing_error) {
    return { id: null, alreadyProcessed: true };
  }
  return { id: row.id, alreadyProcessed: false };
}

async function markWebhookProcessed(client, webhookEventId) {
  await client.query(
    `update webhook_events
        set processed_at = now(),
            processing_error = null
      where id = $1`,
    [webhookEventId]
  );
}

async function markWebhookErrored(client, webhookEventId, error) {
  await client.query(
    `update webhook_events
        set processed_at = now(),
            processing_error = $2
      where id = $1`,
    [webhookEventId, (error && error.message ? error.message : String(error)).slice(0, 2000)]
  );
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let client;
  const organizationId = safeString(getQueryParam(req, 'org'));

  if (!organizationId) {
    return sendJson(res, 400, { error: 'Missing org query parameter.' });
  }

  try {
    client = await pool.connect();

    const connection = await getWebhookSecretForOrg(client, organizationId);
    if (!connection || !connection.webhook_secret) {
      return sendJson(res, 400, { error: 'Unknown or inactive webhook organization.' });
    }

    const rawBody = await readRawBody(req);
    const signature = req.headers['x-razorpay-signature'];

    if (!verifyRazorpaySignature(rawBody, connection.webhook_secret, signature)) {
      return sendJson(res, 400, { error: 'Invalid Razorpay signature.' });
    }

    let eventPayload;
    try {
      eventPayload = JSON.parse(rawBody.toString('utf8'));
    } catch (error) {
      return sendJson(res, 400, { error: 'Malformed JSON webhook body.' });
    }

    const eventType = safeString(eventPayload.event) || 'unknown';
    // Audit #19: prefer Razorpay's own x-razorpay-event-id header for
    // deduplication; fall back to deriving a fingerprint from the payload.
    const eventId =
      safeString(req.headers['x-razorpay-event-id'] || req.headers['X-Razorpay-Event-Id']) ||
      eventFingerprint(eventPayload, rawBody);

    try {
      await client.query('BEGIN');

      const webhookEvent = await logWebhookEvent(client, organizationId, eventId, eventType, eventPayload);

      if (!webhookEvent || webhookEvent.alreadyProcessed) {
        await client.query('COMMIT');
        return sendJson(res, 200, { received: true, duplicate: true });
      }

      await client.query('SAVEPOINT after_webhook_event_log');

      try {
        const result = await processEvent(client, organizationId, eventPayload);
        await markWebhookProcessed(client, webhookEvent.id);
        await client.query('COMMIT');

        // Fire any requested Slack/Discord alert AFTER the commit — a slow or
        // broken alert webhook must never hold open (or roll back) the
        // case-writing transaction. sendAlertIfConfigured never throws.
        const { alert, ...resultPayload } = result || {};
        if (alert) {
          await sendAlertIfConfigured(client, organizationId, alert);
        }

        return sendJson(res, 200, { received: true, ...resultPayload });
      } catch (processingError) {
        console.error('Revessent Razorpay webhook processing failed:', processingError);
        await client.query('ROLLBACK TO SAVEPOINT after_webhook_event_log');
        await markWebhookErrored(client, webhookEvent.id, processingError);
        await client.query('COMMIT');
        // Audit #20: return 5xx so Razorpay retries the delivery. The event
        // row is kept (marked errored) and logWebhookEvent reprocesses
        // previously-errored events on the next attempt instead of deduping
        // them, so the retry has a real chance to succeed.
        return sendJson(res, 500, { received: true, error: 'Event logged but processing failed.' });
      }
    } catch (dbError) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Revessent Razorpay webhook rollback failed:', rollbackError);
      }

      console.error('Revessent Razorpay webhook transaction failed:', dbError);
      return sendJson(res, 200, { received: true, error: 'Webhook accepted but internal processing failed.' });
    }
  } catch (error) {
    console.error('Revessent Razorpay webhook failed:', error);
    return sendJson(res, 500, { error: 'Webhook request failed.' });
  } finally {
    if (client) client.release();
  }
};
