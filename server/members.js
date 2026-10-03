// Revessent /api/members
// Lists Razorpay members/customers for the authenticated organization.

const { Pool } = require('pg');
const { authenticateRequest } = require('./_lib/supabase-auth');
const OPEN_CASE_STATUSES_SQL = `('recovered', 'lost', 'canceled')`;

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

function toInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : 0;
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

    // Audit #64: cursor-style pagination — the old hard `limit 100` silently
    // hid member 101+. Page size caps at 200 so one wild request can't
    // hammer Neon.
    const limit = Math.min(200, Math.max(1, toInt(req.query && req.query.limit, 100) || 100));
    const offset = Math.max(0, toInt(req.query && req.query.offset, 0) || 0);
    // 2nd-opinion #11: search must run server-side — the client only holds
    // the loaded page, so "member 650 of 800" was unfindable.
    const search = String((req.query && req.query.search) || '').trim().slice(0, 100);

    const [membersResult, casesResult, countResult] = await Promise.all([
      client.query(
        `select
           sm.id,
           sm.name,
           sm.email,
           sm.created_at,
           ss.status as sub_status,
           ss.amount_cents as sub_amount_cents,
           ss.currency as sub_currency
         from stripe_members sm
         left join (
           select distinct on (member_id) member_id, status, amount_cents, currency
             from stripe_subscriptions
            order by member_id, updated_at desc nulls last, created_at desc nulls last
         ) ss on ss.member_id = sm.id
         where sm.organization_id = $1
           and ($4 = '' or sm.name ilike '%' || $4 || '%' or sm.email ilike '%' || $4 || '%')
         order by sm.created_at desc nulls last
         limit $2 offset $3`,
        [organizationId, limit, offset, search]
      ),
      client.query(
        `select member_id, id as case_id
           from recovery_cases
          where organization_id = $1
            and status not in ${OPEN_CASE_STATUSES_SQL}
          order by failed_at desc nulls last, created_at desc nulls last`,
        [organizationId]
      ),
      client.query(
        `select count(*)::int as total from stripe_members
          where organization_id = $1
            and ($2 = '' or name ilike '%' || $2 || '%' or email ilike '%' || $2 || '%')`,
        [organizationId, search]
      ),
    ]);

    const openCaseByMember = new Map();
    casesResult.rows.forEach((row) => {
      const key = String(row.member_id);
      if (!openCaseByMember.has(key)) openCaseByMember.set(key, row.case_id);
    });

    return sendJson(res, 200, {
      members: membersResult.rows.map((row) => ({
        id: row.id,
        name: row.name || '',
        email: row.email || '',
        subscriptionStatus: row.sub_status || '',
        subscriptionAmountCents: row.sub_amount_cents == null ? null : toInt(row.sub_amount_cents),
        subscriptionCurrency: row.sub_currency || 'INR',
        openCaseId: openCaseByMember.get(String(row.id)) || null,
      })),
      total: toInt((countResult.rows[0] || {}).total),
      // Audit #64: the client uses this to show "Load more" instead of
      // silently truncating.
      hasMore: offset + membersResult.rows.length < toInt((countResult.rows[0] || {}).total),
    });
  } catch (error) {
    if (error.statusCode && [400, 401, 403].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }
    console.error('Revessent /api/members failed:', error);
    return sendJson(res, 500, { error: 'Could not load members.' });
  } finally {
    if (client) client.release();
  }
};
