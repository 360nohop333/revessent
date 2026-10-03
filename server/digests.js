// Revessent /api/digests
// Lists weekly forensics digests for the authenticated organization.

const { Pool } = require('pg');
const { authenticateRequest } = require('./_lib/supabase-auth');

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

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
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

    const result = await client.query(
      `select *
         from forensics_digests
        where organization_id = $1
        order by week_start_date desc
        limit 20`,
      [user.organization_id]
    );

    return sendJson(res, 200, {
      digests: result.rows.map((row) => ({
        id: row.id,
        weekStartDate: toIso(row.week_start_date),
        weekEndDate: toIso(row.week_end_date),
        totalFailed: toInt(row.total_failed),
        totalRecovered: toInt(row.total_recovered),
        totalLost: toInt(row.total_lost),
        recoveredAmountCents: toInt(row.recovered_amount_cents),
        lostAmountCents: toInt(row.lost_amount_cents),
        aiNarrativeParagraph: row.ai_narrative_paragraph || '',
        sentAt: toIso(row.sent_at),
      })),
    });
  } catch (error) {
    if (error.statusCode && [400, 401, 403].includes(error.statusCode)) {
      return sendJson(res, error.statusCode, { error: error.message });
    }

    console.error('Revessent /api/digests failed:', error);
    return sendJson(res, 500, { error: 'Could not load weekly digests.' });
  } finally {
    if (client) client.release();
  }
};

