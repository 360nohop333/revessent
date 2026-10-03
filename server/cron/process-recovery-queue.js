// Revessent /api/cron/process-recovery-queue
// Daily Vercel Cron job that runs the multi-channel escalation ladder for
// due recovery cases across ALL organizations.
//
// Escalation ladder per due case (next_retry_at <= now()):
//   retry_count 0 → 1  first silent retry
//   retry_count 1 → 2  second silent retry + recovery email (outreach moment)
//   retry_count 2 → 3  final silent retry; failure marks the case lost
//
// Includes runtime timeout budgeting (SAFETY_DEADLINE_MS = 45s) to guarantee
// the function exits cleanly well within Vercel's 60s execution limit.

const { Pool } = require('pg');
const crypto = require('crypto');
const { performRetryAttempt, getRetrySchedule } = require('../recovery/retry');
const { sendRecoveryEmail } = require('../recovery/send-note');

const BATCH_SIZE = 50;
const SAFETY_DEADLINE_MS = 45000; // 45 seconds max loop execution to avoid Vercel 60s timeout

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

  const scheduleDays = getRetrySchedule(caseRow.decline_code, retryCount);

  if (scheduleDays == null) {
    await client.query(
      `update recovery_cases
          set next_retry_at = null,
              updated_at = now()
        where id = $1`,
      [caseRow.id]
    );

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

  const result = await performRetryAttempt(client, caseRow, { automatic: true });

  if (!result.attempted) {
    return { action: 'skipped_pending' };
  }

  let emailsSent = 0;

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
       coalesce((select sum(ra.amount_cents - coalesce(ra.refunded_cents, 0)) from recovery_attributions ra
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

    try {
      await client.query(
        `delete from webhook_events
          where created_at < now() - make_interval(days => $1::int)`,
        [toInt(process.env.WEBHOOK_RETENTION_DAYS, 30) || 30]
      );
    } catch (retentionError) {
      console.error('Revessent cron: webhook retention sweep failed:', retentionError);
    }

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
    const startTime = Date.now();

    for (const caseRow of dueCases) {
      // Finding #6: check elapsed time against safety budget before starting next case
      if (Date.now() - startTime > SAFETY_DEADLINE_MS) {
        console.warn('Revessent cron: execution nearing timeout limit, exiting loop early');
        break;
      }

      processed += 1;

      try {
        const outcome = await processCase(client, caseRow);

        if (outcome.action === 'retry') {
          if (outcome.ok) succeeded += 1;
          else failed += 1;
        } else if (outcome.action === 'email_only') {
          succeeded += 1;
        }

        emailsSent += outcome.emailsSent || 0;
      } catch (error) {
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
