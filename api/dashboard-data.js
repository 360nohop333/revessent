// Revessent /api/dashboard-data
// Real numbers for the logged-in organization's dashboard — this is what
// replaces the hardcoded mock data in dashboard.html.
//
// AUTH: Supabase Bearer token -> email -> Neon users row -> organization_id.
// Identical pattern to api/me.js and api/settings.js, with one deliberate
// difference: this endpoint never accepts an organizationId parameter. It
// always uses the authenticated caller's own org (read-only, safer, simpler).
//
// GET /api/dashboard-data
// GET /api/dashboard-data?range=7d|30d|90d|ytd      (default: 30d)
//
// The response always returns numbers — never null where the frontend expects
// a number. A brand new org with zero data gets zeros and empty arrays.
// Each query is isolated so that one missing table/column degrades that
// section only, instead of taking down the whole dashboard.

const { Pool } = require('pg');

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://zujmouzzqiovgbnanrvv.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  'sb_publishable_7JoawOBwMZ-ZIFmDrjkHSA_AdIWlCi3';

// Hardcoded benchmark for now — not computed from cross-tenant data.
const INDUSTRY_AVG_RECOVERY_PERCENT = 68;

// The chart draws exactly eight bars; that is a design constant, not a range.
const CHART_WEEKS = 8;
const QUEUE_LIMIT = 20;
const ACTIVITY_LIMIT = 10;
const DEFAULT_CURRENCY = 'inr';

// Cases in these states are settled and therefore not "active"/"at risk".
const TERMINAL_STATUSES = ['recovered', 'lost', 'canceled'];

const DAY_MS = 24 * 60 * 60 * 1000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function getBearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

// ─── Auth (Supabase token -> Neon user) ──────────────────────────────────────

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
  const email = (supabaseUser && supabaseUser.email ? String(supabaseUser.email) : '')
    .trim()
    .toLowerCase();

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
  const { email } = await verifySupabaseToken(getBearerToken(req));
  const user = await findNeonUserByEmail(client, email);

  if (!user) {
    const error = new Error('No Revessent user found for this Supabase account.');
    error.statusCode = 404;
    throw error;
  }

  if (!user.organization_id) {
    const error = new Error('This account has no organization yet.');
    error.statusCode = 404;
    throw error;
  }

  return { email, user };
}

// ─── Range handling ──────────────────────────────────────────────────────────

const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

/**
 * Resolve ?range= into { key, start, priorStart, days }.
 * `priorStart` opens the equally-sized window immediately before `start`,
 * which is what the "vs last period" percentage compares against.
 */
function resolveRange(rawRange, now) {
  const key = Object.prototype.hasOwnProperty.call(RANGE_DAYS, rawRange)
    ? rawRange
    : rawRange === 'ytd'
      ? 'ytd'
      : '30d';

  let start;
  let days;

  if (key === 'ytd') {
    start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    days = Math.max(1, Math.round((now.getTime() - start.getTime()) / DAY_MS));
  } else {
    days = RANGE_DAYS[key];
    start = new Date(now.getTime() - days * DAY_MS);
  }

  return { key, start, days, priorStart: new Date(start.getTime() - days * DAY_MS) };
}

/** The eight most recent week-starts (Monday, UTC), oldest first. */
function chartWeekStarts(now) {
  const cursor = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const mondayOffset = (cursor.getUTCDay() + 6) % 7; // Mon = 0 … Sun = 6
  cursor.setUTCDate(cursor.getUTCDate() - mondayOffset);

  const starts = [];
  for (let i = CHART_WEEKS - 1; i >= 0; i--) {
    starts.push(new Date(cursor.getTime() - i * 7 * DAY_MS));
  }
  return starts;
}

function weekLabel(date) {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// ─── Small shaping helpers ───────────────────────────────────────────────────

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function sumCents(rows, column) {
  return rows.reduce((total, row) => total + toInt(row[column]), 0);
}

function percentChange(current, prior) {
  if (!prior) return current > 0 ? 100 : 0;
  return Math.round(((current - prior) / prior) * 100);
}

/** Run one query, and fall back to `fallback` (plus a server log) if it fails. */
async function section(client, label, fallback, text, params) {
  try {
    const result = await client.query(text, params);
    return result.rows;
  } catch (error) {
    console.error(`Revessent /api/dashboard-data — ${label} failed:`, error.message);
    return fallback;
  }
}

/** Best available display name: stored name, else a tidied email local-part. */
function memberName(row) {
  const name = row.name ? String(row.name).trim() : '';
  if (name) return name;

  const email = row.email ? String(row.email).trim() : '';
  if (email) {
    const guess = email
      .split('@')[0]
      .replace(/[._-]+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
    if (guess) return guess;
  }

  return 'Unknown member';
}

// ─── Queries ─────────────────────────────────────────────────────────────────

const OPEN_CASE_FILTER = `status <> all($2::text[])`;

async function loadDashboard(client, organizationId, range, now) {
  const weekStarts = chartWeekStarts(now);
  const chartFrom = weekStarts[0];

  const [
    recoveredRows,
    priorRecoveredRows,
    atRiskRows,
    rateRows,
    statusRows,
    chartRecoveredRows,
    chartLostRows,
    queueRows,
    activityRows,
  ] = await Promise.all([
    // 1 · revenue recovered in range
    section(
      client,
      'revenue recovered',
      [],
      `select coalesce(sum(amount_cents), 0) as total
         from recovery_attributions
        where organization_id = $1
          and recovered_at >= $2`,
      [organizationId, range.start]
    ),

    // 2 · the equally-sized window before it, for the % change pill
    section(
      client,
      'prior revenue recovered',
      [],
      `select coalesce(sum(amount_cents), 0) as total
         from recovery_attributions
        where organization_id = $1
          and recovered_at >= $2
          and recovered_at < $3`,
      [organizationId, range.priorStart, range.start]
    ),

    // 3 · revenue at risk (open cases) + how many
    section(
      client,
      'revenue at risk',
      [],
      `select coalesce(sum(amount_cents), 0) as total,
              count(*) as open_cases,
              max(currency) as currency
         from recovery_cases
        where organization_id = $1
          and ${OPEN_CASE_FILTER}`,
      [organizationId, TERMINAL_STATUSES]
    ),

    // 4 · recovery rate — settled cases only, all time
    section(
      client,
      'recovery rate',
      [],
      `select count(*) filter (where status = 'recovered') as recovered,
              count(*) filter (where status = any($2::text[])) as settled
         from recovery_cases
        where organization_id = $1`,
      [organizationId, ['recovered', 'lost']]
    ),

    // 5 · active case breakdown by status
    section(
      client,
      'active case breakdown',
      [],
      `select status, count(*) as n
         from recovery_cases
        where organization_id = $1
          and ${OPEN_CASE_FILTER}
        group by status`,
      [organizationId, TERMINAL_STATUSES]
    ),

    // 6a · chart — recovered per week
    section(
      client,
      'weekly recovered',
      [],
      `select amount_cents, recovered_at
         from recovery_attributions
        where organization_id = $1
          and recovered_at >= $2`,
      [organizationId, chartFrom]
    ),

    // 6b · chart — lost per week
    section(
      client,
      'weekly lost',
      [],
      `select amount_cents, lost_at
         from recovery_cases
        where organization_id = $1
          and status = 'lost'
          and lost_at >= $2`,
      [organizationId, chartFrom]
    ),

    // 7 · the live recovery queue
    section(
      client,
      'recovery queue',
      [],
      `select rc.id,
              rc.status,
              rc.decline_code,
              rc.amount_cents,
              rc.currency,
              rc.failed_at,
              rc.retry_count,
              rc.next_retry_at,
              sm.name,
              sm.email
         from recovery_cases rc
         left join stripe_members sm on sm.id = rc.member_id
        where rc.organization_id = $1
          and rc.status <> all($2::text[])
        order by rc.failed_at desc
        limit $3`,
      [organizationId, TERMINAL_STATUSES, QUEUE_LIMIT]
    ),

    // 8 · recent activity
    section(
      client,
      'activity feed',
      [],
      `select type, title, description, amount_cents, currency, created_at
         from activity_feed
        where organization_id = $1
        order by created_at desc
        limit $2`,
      [organizationId, ACTIVITY_LIMIT]
    ),
  ]);

  // ── KPIs ────────────────────────────────────────────────────────────────
  const recoveredCents = toInt(recoveredRows[0] && recoveredRows[0].total);
  const priorCents = toInt(priorRecoveredRows[0] && priorRecoveredRows[0].total);
  const atRiskCents = toInt(atRiskRows[0] && atRiskRows[0].total);
  const openCaseCount = toInt(atRiskRows[0] && atRiskRows[0].open_cases);

  const settled = toInt(rateRows[0] && rateRows[0].settled);
  const recoveredCount = toInt(rateRows[0] && rateRows[0].recovered);
  const recoveryPercent = settled > 0 ? Math.round((recoveredCount / settled) * 100) : 0;

  const activeCases = {
    detected: 0,
    retrying: 0,
    awaiting_approval: 0,
    note_sent: 0,
    checkout_sent: 0,
  };
  statusRows.forEach((row) => {
    if (Object.prototype.hasOwnProperty.call(activeCases, row.status)) {
      activeCases[row.status] = toInt(row.n);
    }
  });

  // ── Weekly chart ────────────────────────────────────────────────────────
  const weeklyChart = weekStarts.map((start) => ({
    weekLabel: weekLabel(start),
    weekStart: start.toISOString(),
    recovered: 0,
    lost: 0,
  }));

  const bucket = (value) => {
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return -1;
    const index = Math.floor((time - weekStarts[0].getTime()) / (7 * DAY_MS));
    return index >= 0 && index < CHART_WEEKS ? index : -1;
  };

  chartRecoveredRows.forEach((row) => {
    const i = bucket(row.recovered_at);
    if (i >= 0) weeklyChart[i].recovered += toInt(row.amount_cents);
  });
  chartLostRows.forEach((row) => {
    const i = bucket(row.lost_at);
    if (i >= 0) weeklyChart[i].lost += toInt(row.amount_cents);
  });

  // ── Queue + activity ────────────────────────────────────────────────────
  const recoveryQueue = queueRows.map((row) => ({
    caseId: row.id,
    memberName: memberName(row),
    memberEmail: row.email || '',
    amountCents: toInt(row.amount_cents),
    currency: row.currency || DEFAULT_CURRENCY,
    declineCode: row.decline_code || 'unknown',
    status: row.status,
    retryCount: toInt(row.retry_count),
    nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at).toISOString() : null,
    failedAt: row.failed_at ? new Date(row.failed_at).toISOString() : null,
  }));

  const activity = activityRows.map((row) => ({
    type: row.type || 'note',
    title: row.title || '',
    description: row.description || '',
    amountCents: row.amount_cents == null ? null : toInt(row.amount_cents),
    currency: row.currency || DEFAULT_CURRENCY,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  }));

  const currency =
    (queueRows.find((row) => row.currency) || {}).currency ||
    (atRiskRows[0] && atRiskRows[0].currency) ||
    (activityRows.find((row) => row.currency) || {}).currency ||
    DEFAULT_CURRENCY;

  return {
    range: range.key,
    rangeDays: range.days,
    currency: String(currency).toLowerCase(),
    revenueRecovered: {
      amountCents: recoveredCents,
      priorAmountCents: priorCents,
      percentChangeVsPrior: percentChange(recoveredCents, priorCents),
    },
    revenueAtRisk: {
      amountCents: atRiskCents,
      openCaseCount,
    },
    recoveryRate: {
      percent: recoveryPercent,
      recoveredCount,
      settledCount: settled,
      industryAvgPercent: INDUSTRY_AVG_RECOVERY_PERCENT,
    },
    activeCases,
    weeklyChart,
    recoveryQueue,
    activity,
    generatedAt: now.toISOString(),
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let client;

  try {
    client = await pool.connect();
    const { user } = await authenticateRequest(req, client);

    const query = (req.query && req.query.range) || '';
    const range = resolveRange(String(query).trim().toLowerCase(), new Date());

    const data = await loadDashboard(client, user.organization_id, range, new Date());
    return sendJson(res, 200, data);
  } catch (error) {
    if (error.statusCode && [401, 404].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }

    console.error('Revessent /api/dashboard-data failed:', error);
    return sendJson(res, 500, { error: 'Could not load dashboard data.' });
  } finally {
    if (client) client.release();
  }
};
