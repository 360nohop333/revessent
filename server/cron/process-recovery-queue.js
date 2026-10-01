// Revessent /api/cron/process-recovery-queue
// Daily Vercel Cron job (Hobby plan: one run per day) that runs the
// multi-channel escalation ladder for due recovery cases across ALL
// organizations — combining silent Razorpay retries with outreach emails at
// the right moments instead of waiting for a human to click "Retry now" /
// "Draft recovery email".
//
// Escalation ladder per due case (next_retry_at <= now()):
//   retry_count 0 → 1  first silent retry
//   retry_count 1 → 2  second silent retry + recovery email (outreach moment)
//   retry_count 2 → 3  final silent retry; failure marks the case lost
//                      (handled by the shared max_retries logic in retry.js)
//   non-retryable decline codes (bad card) → no silent retry at all; send a
//   recovery email asking for a new payment method instead, and do NOT count
//   it toward max_retries since no retry was actually attempted.
//
// Auth: Vercel Cron has no Supabase user to authenticate — it runs as a
// system job. Vercel automatically sends `Authorization: Bearer $CRON_SECRET`
// when the CRON_SECRET environment variable is set on the project, so this
// endpoint verifies exactly that header and rejects anything else with 401.
//
// Scheduling (vercel.json) — Hobby plan allows ONE cron job, max once per
// day, so this runs daily at 09:00 IST (03:30 UTC):
//   { "crons": [{ "path": "/api/cron/process-recovery-queue",
//                 "schedule": "30 3 * * *" }] }
// (On a Pro plan this can be tightened to "0 * * * *" for hourly runs.)

const { Pool } = require('pg');
const crypto = require('crypto');
const { performRetryAttempt, getRetrySchedule } = require('../recovery/retry');
const { sendRecoveryEmail } = require('../recovery/send-note');
const { logAudit } = require('../_lib/audit');

// Process at most 50 due cases per run so one cron invocation cannot time
// out on a huge backlog — anything past the batch is picked up by the next
// run (the query is ordered by next_retry_at asc, oldest first).
const BATCH_SIZE = 50;

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

function cleanString(value) {
  return value == null ? '' : String(value).trim();
}

function toInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function verifyCronSecret(req) {
  const secret = cleanString(process.env.CRON_SECRET);

  if (!secret) {
    const error = new Error('Cron secret not configured.');
    error.statusCode = 500;
    throw error;
  }

  const token = getBearerToken(req);
  if (!token) return false;

  // Timing-safe comparison of sha256 digests (hashing first sidesteps the
  // equal-length requirement of crypto.timingSafeEqual).
  const expected = crypto.createHash('sha256').update(secret, 'utf8').digest();
  const actual = crypto.createHash('sha256').update(token, 'utf8').digest();
  return crypto.timingSafeEqual(expected, actual);
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
      JSON.stringify(values.metadata || {}),
    ]
  );
}

async function loadDueCases(client) {
  const result = await client.query(
    `select rc.*, o.trust_level as org_trust_level
       from recovery_cases rc
       join organizations o on o.id = rc.organization_id
      where rc.status in ('detected', 'retrying')
        and rc.next_retry_at is not null
        and rc.next_retry_at <= now()
      order by rc.next_retry_at asc
      limit $1`,
    [BATCH_SIZE]
  );

  return result.rows;
}

async function processCase(client, caseRow) {
  const organizationId = caseRow.organization_id;
  const retryCount = toInt(caseRow.retry_count, 0);
  const maxRetries = Math.max(1, toInt(caseRow.max_retries, 3));

  // Reuse Feature 1's decline-aware logic: null means this decline code never
  // allows an automatic retry (the card itself is bad).
  const scheduleDays = getRetrySchedule(caseRow.decline_code, retryCount);

  if (scheduleDays == null) {
    // Non-retryable decline code (legacy case that still has next_retry_at
    // set, e.g. created before decline-aware scheduling): no silent retry —
    // send a recovery email asking for a new payment method instead. No retry
    // is attempted, so retry_count / max_retries are left untouched.
    //
    // Clear next_retry_at first so the case can never come back due (and get
    // re-emailed every hour) even if the email send below fails.
    await client.query(
      `update recovery_cases
          set next_retry_at = null,
              updated_at = now()
        where id = $1`,
      [caseRow.id]
    );

    // Audit #38: while the workspace requires approval (the default trust
    // level), the scheduler must NOT email customers on its own — park the
    // case for a human instead.
    if (String(caseRow.org_trust_level || 'approval_required') === 'approval_required') {
      await client.query(
        `update recovery_cases set status = 'awaiting_approval', updated_at = now() where id = $1`,
        [caseRow.id]
      );
      await insertActivity(client, {
        organizationId,
        type: 'awaiting_approval',
        title: 'Recovery email needs approval',
        description: 'A recovery email was drafted for this case but not sent — this workspace requires approval before customer outreach.',
        amountCents: caseRow.amount_cents,
        currency: caseRow.currency,
        memberId: caseRow.member_id,
        caseId: caseRow.id,
        metadata: { source: 'cron', automatic: true },
      });
      return { action: 'awaiting_approval' };
    }

    await sendRecoveryEmail({
      client,
      organizationId,
      caseId: caseRow.id,
      automatic: true,
      updateCaseStatus: true,
    });

    return { action: 'email_only', emailsSent: 1 };
  }

  if (retryCount >= maxRetries) {
    // Safety valve: the case is due but already exhausted its retries (legacy
    // data or a race) — close it out as lost so it stops appearing as due.
    await client.query(
      `update recovery_cases
          set status = 'lost',
              lost_at = now(),
              updated_at = now()
        where id = $1`,
      [caseRow.id]
    );

    await insertActivity(client, {
      organizationId,
      type: 'lost',
      title: 'Recovery automatically marked lost',
      description: 'Case was due but had already exhausted its retry attempts.',
      amountCents: caseRow.amount_cents,
      currency: caseRow.currency,
      memberId: caseRow.member_id,
      caseId: caseRow.id,
      metadata: { source: 'automatic_retry', automatic: true },
    });

    return { action: 'closed_lost' };
  }

  // Silent Razorpay retry (shared core logic with the manual retry endpoint —
  // includes decline-aware next_retry_at scheduling and the max_retries →
  // lost transition on the final attempt).
  const result = await performRetryAttempt(client, caseRow, { automatic: true });

  if (!result.attempted) {
    // A retry was already in flight (manual click or a previous run) — leave
    // the case for the next hourly run.
    return { action: 'skipped_pending' };
  }

  let emailsSent = 0;

  // Escalate to outreach on the second retry (retry_count 1 → 2): the "we
  // tried quietly, now we talk to the customer" moment. The case stays
  // 'retrying' (updateCaseStatus: false) so the final ladder step still runs.
  if (retryCount === 1 && result.newStatus !== 'lost' && String(caseRow.org_trust_level || 'approval_required') !== 'approval_required') {
    try {
      await sendRecoveryEmail({
        client,
        organizationId,
        caseId: caseRow.id,
        automatic: true,
        updateCaseStatus: false,
      });
      emailsSent += 1;
    } catch (emailError) {
      // The retry itself succeeded — an email failure must not mark the whole
      // case as failed; it is logged and the ladder continues.
      console.error('Revessent cron: escalation email failed for case', caseRow.id, emailError);
    }
  }

  return {
    action: 'retry',
    ok: result.ok,
    emailsSent,
    newStatus: result.newStatus,
    error: result.error || null,
  };
}

// Audit #54: one forensics_digests row per org per ISO week, built from
// recovery_cases + recovery_attributions. Plain deterministic narrative — no
// Gemini call from the cron (cost + trust: the numbers speak for themselves).
async function generateWeeklyDigests(client) {
  const weekStart = new Date();
  weekStart.setUTCHours(0, 0, 0, 0);
  weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7)); // Monday
  const weekEnd = new Date(weekStart.getTime() + 7 * 864e5);

  const result = await client.query(
    `insert into forensics_digests
       (id, organization_id, week_start_date, week_end_date,
        total_failed, total_recovered, total_lost,
        recovered_amount_cents, lost_amount_cents, top_decline_reasons,
        ai_narrative_paragraph, created_at)
     select
       gen_random_uuid(),
       rc.organization_id,
       $1::timestamptz,
       $2::timestamptz,
       count(*) filter (where rc.failed_at >= $1::timestamptz),
       count(*) filter (where rc.recovered_at >= $1::timestamptz),
       count(*) filter (where rc.lost_at >= $1::timestamptz),
       coalesce((select sum(ra.amount_cents) from recovery_attributions ra
                  where ra.organization_id = rc.organization_id
                    and ra.recovered_at >= $1::timestamptz), 0),
       coalesce(sum(rc.amount_cents) filter (where rc.lost_at >= $1::timestamptz), 0),
       coalesce((
         select jsonb_agg(jsonb_build_object('code', d.decline_code, 'count', d.count))
         from (
           select rc2.decline_code, count(*)::int as count
             from recovery_cases rc2
            where rc2.organization_id = rc.organization_id
              and rc2.failed_at >= $1::timestamptz
            group by rc2.decline_code
            order by count desc
            limit 3
         ) d
       ), '[]'::jsonb),
       'This week: ' ||
         count(*) filter (where rc.failed_at >= $1::timestamptz) || ' payments failed, ' ||
         count(*) filter (where rc.recovered_at >= $1::timestamptz) || ' were recovered, ' ||
         count(*) filter (where rc.lost_at >= $1::timestamptz) || ' were lost.',
       now()
     from recovery_cases rc
    where rc.organization_id in (
      select distinct organization_id from recovery_cases
       where failed_at >= $1::timestamptz or recovered_at >= $1::timestamptz or lost_at >= $1::timestamptz
    )
    group by rc.organization_id
    on conflict (organization_id, week_start_date) do update
      set week_end_date = excluded.week_end_date,
          total_failed = excluded.total_failed,
          total_recovered = excluded.total_recovered,
          total_lost = excluded.total_lost,
          recovered_amount_cents = excluded.recovered_amount_cents,
          lost_amount_cents = excluded.lost_amount_cents,
          top_decline_reasons = excluded.top_decline_reasons,
          ai_narrative_paragraph = excluded.ai_narrative_paragraph`,
    [weekStart.toISOString(), weekEnd.toISOString()]
  );

  return result.rowCount || 0;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let client;

  let authorized;
  try {
    authorized = verifyCronSecret(req);
  } catch (error) {
    return sendJson(res, error.statusCode || 500, { error: error.message });
  }

  if (!authorized) {
    return sendJson(res, 401, { error: 'Unauthorized.' });
  }

  try {
    client = await pool.connect();

    // Audit #32: sweep attempts whose function crashed mid-flight — a
    // 'pending' attempt older than an hour is stale; fail it so its
    // idempotency key stops blocking future retries with 409s.
    try {
      await client.query(
        `update recovery_attempts
            set status = 'failed',
                error_code = 'stale',
                error_message = 'Marked stale by scheduler (function crashed before recording an outcome)',
                executed_at = now()
          where status = 'pending'
            and created_at < now() - interval '1 hour'`
      );
    } catch (sweepError) {
      console.error('Revessent cron: stale-attempt sweep failed:', sweepError);
    }

    // Audit #14: raw webhook payloads don't live in the DB forever — default
    // 30 days (WEBHOOK_RETENTION_DAYS), then the rows go. The privacy policy
    // states the same window.
    try {
      await client.query(
        `delete from webhook_events
          where created_at < now() - make_interval(days => $1::int)`,
        [toInt(process.env.WEBHOOK_RETENTION_DAYS, 30) || 30]
      );
    } catch (retentionError) {
      console.error('Revessent cron: webhook retention sweep failed:', retentionError);
    }

    // Audit #54: generate the weekly forensics digest for every org that had
    // activity this week. Best-effort — a failure here must never mark the
    // cron run failed.
    try {
      const digestCount = await generateWeeklyDigests(client);
      console.log('Revessent cron: weekly digests upserted:', digestCount);
    } catch (digestError) {
      console.error('Revessent cron: weekly digest generation failed:', digestError);
    }

    const dueCases = await loadDueCases(client);

    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let emailsSent = 0;

    for (const caseRow of dueCases) {
      processed += 1;

      try {
        const outcome = await processCase(client, caseRow);

        if (outcome.action === 'retry') {
          if (outcome.ok) succeeded += 1;
          else failed += 1;
        } else if (outcome.action === 'email_only') {
          succeeded += 1;
        }
        // 'skipped_pending' and 'closed_lost' count as processed only.

        emailsSent += outcome.emailsSent || 0;
      } catch (error) {
        // One bad case (missing connection, drafting failure, ...) must not
        // abort the run — everything already processed stays recorded.
        failed += 1;
        console.error('Revessent cron: could not process recovery case', caseRow.id, error);
      }
    }

    return sendJson(res, 200, { processed, succeeded, failed, emailsSent });
  } catch (error) {
    console.error('Revessent /api/cron/process-recovery-queue failed:', error);
    return sendJson(res, 500, { error: 'Could not process the recovery queue.' });
  } finally {
    if (client) client.release();
  }
};
