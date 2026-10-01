// Revessent /api/dashboard-data
// Verifies the caller's Supabase access token, resolves the user's Neon
// organization by Supabase user id, and returns real dashboard metrics for that org.

const { Pool } = require('pg');

const SUPABASE_URL = 'https://zujmouzzqiovgbnanrvv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7JoawOBwMZ-ZIFmDrjkHSA_AdIWlCi3';
const INDUSTRY_AVG_RECOVERY_PERCENT = 68;
const OPEN_CASE_STATUSES_SQL = `('recovered', 'lost', 'canceled')`;

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

function getQueryParam(req, key) {
  if (req.query && req.query[key] != null) return String(req.query[key]);

  try {
    const url = new URL(req.url, 'https://revessent.local');
    return url.searchParams.get(key) || '';
  } catch (_) {
    return '';
  }
}

function parseRangeDays(req) {
  const range = getQueryParam(req, 'range') || '30d';

  if (range === '7d') return 7;
  if (range === '90d') return 90;
  return 30;
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

function toNumber(value) {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toInt(value) {
  return Math.round(toNumber(value));
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function percentChange(current, prior) {
  if (prior > 0) return Math.round(((current - prior) / prior) * 100);
  if (current > 0) return 100;
  return 0;
}

function mapStatusKey(status) {
  if (status === 'awaiting_approval') return 'awaitingApproval';
  if (status === 'checkout_sent') return 'checkoutSent';
  if (status === 'note_sent') return 'noteSent';
  return status;
}

async function getRevenueRecovered(client, organizationId, rangeDays) {
  const result = await client.query(
    `select
       coalesce(sum(amount_cents) filter (
         where recovered_at >= now() - ($2::int * interval '1 day')
       ), 0)::bigint as current_cents,
       coalesce(sum(amount_cents) filter (
         where recovered_at >= now() - (($2::int * 2) * interval '1 day')
           and recovered_at <  now() - ($2::int * interval '1 day')
       ), 0)::bigint as prior_cents
     from recovery_attributions
     where organization_id = $1
       and recovered_at >= now() - (($2::int * 2) * interval '1 day')`,
    [organizationId, rangeDays]
  );

  const row = result.rows[0] || {};
  const amountCents = toInt(row.current_cents);
  const priorCents = toInt(row.prior_cents);

  return {
    amountCents,
    percentChangeVsPrior: percentChange(amountCents, priorCents),
  };
}

async function getRevenueAtRisk(client, organizationId) {
  const result = await client.query(
    `select
       coalesce(sum(amount_cents), 0)::bigint as amount_cents,
       count(*)::int as open_case_count
     from recovery_cases
     where organization_id = $1
       and status not in ${OPEN_CASE_STATUSES_SQL}`,
    [organizationId]
  );

  const row = result.rows[0] || {};

  return {
    amountCents: toInt(row.amount_cents),
    openCaseCount: toInt(row.open_case_count),
  };
}

async function getRecoveryRate(client, organizationId) {
  const result = await client.query(
    `select
       count(*) filter (where status = 'recovered')::int as recovered_count,
       count(*) filter (where status in ('recovered', 'lost'))::int as closed_count
     from recovery_cases
     where organization_id = $1`,
    [organizationId]
  );

  const row = result.rows[0] || {};
  const recovered = toInt(row.recovered_count);
  const closed = toInt(row.closed_count);

  return {
    percent: closed > 0 ? Math.round((recovered / closed) * 100) : 0,
    industryAvgPercent: INDUSTRY_AVG_RECOVERY_PERCENT,
  };
}

async function getActiveCases(client, organizationId) {
  const result = await client.query(
    `select status, count(*)::int as count
     from recovery_cases
     where organization_id = $1
       and status not in ${OPEN_CASE_STATUSES_SQL}
     group by status`,
    [organizationId]
  );

  const activeCases = {
    retrying: 0,
    awaitingApproval: 0,
    checkoutSent: 0,
    detected: 0,
  };

  for (const row of result.rows) {
    const key = mapStatusKey(row.status);
    if (Object.prototype.hasOwnProperty.call(activeCases, key)) {
      activeCases[key] = toInt(row.count);
    }
  }

  return activeCases;
}

async function getWeeklyChart(client, organizationId) {
  const result = await client.query(
    `with weeks as (
       select generate_series(
         date_trunc('week', now()) - interval '7 weeks',
         date_trunc('week', now()),
         interval '1 week'
       )::date as week_start
     ), recovered as (
       select
         date_trunc('week', recovered_at)::date as week_start,
         coalesce(sum(amount_cents), 0)::bigint as recovered_cents
       from recovery_attributions
       where organization_id = $1
         and recovered_at >= date_trunc('week', now()) - interval '7 weeks'
         and recovered_at <  date_trunc('week', now()) + interval '1 week'
       group by 1
     ), lost as (
       select
         date_trunc('week', lost_at)::date as week_start,
         coalesce(sum(amount_cents), 0)::bigint as lost_cents
       from recovery_cases
       where organization_id = $1
         and status = 'lost'
         and lost_at >= date_trunc('week', now()) - interval '7 weeks'
         and lost_at <  date_trunc('week', now()) + interval '1 week'
       group by 1
     )
     select
       to_char(w.week_start, 'Mon FMDD') as week_label,
       coalesce(r.recovered_cents, 0)::bigint as recovered_cents,
       coalesce(l.lost_cents, 0)::bigint as lost_cents
     from weeks w
     left join recovered r on r.week_start = w.week_start
     left join lost l on l.week_start = w.week_start
     order by w.week_start asc`,
    [organizationId]
  );

  return result.rows.map((row) => ({
    weekLabel: row.week_label || '',
    recoveredCents: toInt(row.recovered_cents),
    lostCents: toInt(row.lost_cents),
  }));
}

async function getDeclineBreakdown(client, organizationId, rangeDays) {
  // Aggregate WHY payments failed over the selected range — feeds the
  // "Why payments are failing" card on the dashboard.
  const result = await client.query(
    `select decline_code,
            count(*)::int as count,
            coalesce(sum(amount_cents), 0)::bigint as total_amount_cents
       from recovery_cases
      where organization_id = $1
        and failed_at >= now() - ($2::int * interval '1 day')
      group by decline_code
      order by count desc`,
    [organizationId, rangeDays]
  );

  return result.rows.map((row) => ({
    declineCode: row.decline_code || 'unknown',
    count: toInt(row.count),
    totalAmountCents: toInt(row.total_amount_cents),
  }));
}

async function getRecoveryQueue(client, organizationId) {
  const result = await client.query(
    `select
       rc.id,
       sm.name as member_name,
       sm.email as member_email,
       rc.amount_cents,
       rc.currency,
       rc.decline_code,
       rc.status,
       rc.failed_at
     from recovery_cases rc
     join stripe_members sm on rc.member_id = sm.id
     where rc.organization_id = $1
       and rc.status not in ${OPEN_CASE_STATUSES_SQL}
     order by rc.failed_at desc nulls last, rc.created_at desc nulls last
     limit 20`,
    [organizationId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    memberName: row.member_name || '',
    memberEmail: row.member_email || '',
    amountCents: toInt(row.amount_cents),
    currency: row.currency || 'INR',
    declineCode: row.decline_code || 'unknown',
    status: row.status || 'detected',
    failedAt: toIso(row.failed_at),
  }));
}

async function getActivity(client, organizationId) {
  const result = await client.query(
    `select type, title, description, amount_cents, currency, created_at
     from activity_feed
     where organization_id = $1
     order by created_at desc nulls last
     limit 10`,
    [organizationId]
  );

  return result.rows.map((row) => ({
    type: row.type || '',
    title: row.title || '',
    description: row.description || '',
    amountCents: toInt(row.amount_cents),
    currency: row.currency || 'INR',
    createdAt: toIso(row.created_at),
  }));
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let client;

  try {
    client = await pool.connect();
    const { user } = await authenticateRequest(req, client);
    const organizationId = user.organization_id;
    const rangeDays = parseRangeDays(req);

    const [
      revenueRecovered,
      revenueAtRisk,
      recoveryRate,
      activeCases,
      weeklyChart,
      declineBreakdown,
      recoveryQueue,
      activity,
    ] = await Promise.all([
      getRevenueRecovered(client, organizationId, rangeDays),
      getRevenueAtRisk(client, organizationId),
      getRecoveryRate(client, organizationId),
      getActiveCases(client, organizationId),
      getWeeklyChart(client, organizationId),
      getDeclineBreakdown(client, organizationId, rangeDays),
      getRecoveryQueue(client, organizationId),
      getActivity(client, organizationId),
    ]);

    return sendJson(res, 200, {
      revenueRecovered,
      revenueAtRisk,
      recoveryRate,
      activeCases,
      weeklyChart,
      declineBreakdown,
      recoveryQueue,
      activity,
    });
  } catch (error) {
    if (error.statusCode === 401) {
      return sendJson(res, 401, { error: error.message || 'Unauthorized.' });
    }

    console.error('Revessent /api/dashboard-data failed:', error);
    return sendJson(res, 500, { error: 'Could not load dashboard data.' });
  } finally {
    if (client) client.release();
  }
};
