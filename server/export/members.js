// Revessent /api/export/members
// Bulk CSV export of stripe_members (with subscription status and lifetime
// recovered amount from recovery_attributions) for the authenticated user's
// organization. Returns text/csv (not JSON).

const { Pool } = require('pg');
const { authenticateRequest } = require('../_lib/supabase-auth'); // audit #66: shared auth (local JWT verify when SUPABASE_JWT_SECRET is set)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zujmouzzqiovgbnanrvv.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_7JoawOBwMZ-ZIFmDrjkHSA_AdIWlCi3';

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

// Standard CSV escaping: wrap in double quotes when the value contains a
// comma, double quote, or newline; escape internal double quotes by doubling
// them. Never skip this — member names/emails can contain commas or quotes.
function csvEscape(value) {
  if (value == null) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

// Amounts are written in the currency's major unit (cents / 100) as plain
// numbers — friendliest for spreadsheets.
function toMajorUnits(value) {
  if (value == null) return '';
  const cents = Number(value);
  if (!Number.isFinite(cents)) return '';
  const major = cents / 100;
  return String(Number.isInteger(major) ? major : major.toFixed(2));
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

    const result = await client.query(
      `select
         sm.name,
         sm.email,
         ss.status as sub_status,
         ss.amount_cents as sub_amount_cents,
         recovered.total_cents as lifetime_recovered_cents
       from stripe_members sm
       left join stripe_subscriptions ss on ss.member_id = sm.id
       left join (
         select member_id, sum(amount_cents) as total_cents
           from recovery_attributions
          where organization_id = $1
          group by member_id
       ) recovered on recovered.member_id = sm.id
      where sm.organization_id = $1
      order by sm.created_at desc nulls last
      limit 10000`,
      [organizationId]
    );

    const header = [
      'Member Name',
      'Email',
      'Subscription Status',
      'Subscription Amount',
      'Lifetime Recovered',
    ].join(',');

    const rows = result.rows.map((row) =>
      [
        csvEscape(row.name || ''),
        csvEscape(row.email || ''),
        csvEscape(row.sub_status || ''),
        csvEscape(toMajorUnits(row.sub_amount_cents)),
        csvEscape(toMajorUnits(row.lifetime_recovered_cents)),
      ].join(',')
    );

    const csv = [header, ...rows].join('\r\n');
    const dateLabel = new Date().toISOString().slice(0, 10);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="revessent-members-${dateLabel}.csv"`);
    return res.end(csv);
  } catch (error) {
    if (error.statusCode && [400, 401, 403, 404].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }

    console.error('Revessent /api/export/members failed:', error);
    return sendJson(res, 500, { error: 'Could not export members.' });
  } finally {
    if (client) client.release();
  }
};
