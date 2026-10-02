// Revessent /api/unsubscribe (audit #35) — one-click unsubscribe from recovery
// emails. The link's HMAC token (signed with ENCRYPTION_KEY) IS the auth, so
// this endpoint is public by design. Adds the member to suppression_list,
// which send-note checks before every send.

const { Pool } = require('pg');
const { verifyUnsubscribeToken } = require('./_lib/unsubscribe-token');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  ssl: { rejectUnauthorized: false },
});

function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
}

const PAGE = (title, line) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title} — Revessent</title></head><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;background:#f9f4ea;color:#1D1C1A;display:flex;align-items:center;justify-content:center;min-height:100vh"><div style="max-width:460px;padding:40px 32px;text-align:center"><p style="font-size:26px;margin:0 0 10px;letter-spacing:-.02em">${title}</p><p style="color:#6B6860;line-height:1.7;margin:0">${line}</p><p style="margin-top:26px;font-size:13px;color:#8E8C86"><a href="/" style="color:#35608f">revessent.</a></p></div></body></html>`;

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.statusCode = 405;
    return res.end();
  }

  const token = String((req.query && req.query.token) || new URL(req.url || '', 'http://x').searchParams.get('token') || '');
  const payload = verifyUnsubscribeToken(token);

  if (!payload) {
    return sendHtml(res, 400, PAGE('Invalid link', 'This unsubscribe link is malformed or has expired. If you keep receiving recovery emails you didn\'t ask for, reply to one and we\'ll fix it.'));
  }

  let client;
  try {
    client = await pool.connect();
    await client.query(
      `insert into suppression_list (id, organization_id, member_id, email, unsubscribed_at, created_at)
       values ($1, $2, $3, $4, now(), now())
       on conflict (organization_id, lower(email)) do nothing`,
      [require('crypto').randomUUID(), payload.organizationId, payload.memberId, payload.email.toLowerCase()]
    );
    return sendHtml(res, 200, PAGE('You\'re unsubscribed', 'You won\'t receive any more payment-recovery emails from this workspace. This doesn\'t cancel your subscription — contact the business directly for anything billing-related.'));
  } catch (error) {
    console.error('Revessent /api/unsubscribe failed:', error);
    return sendHtml(res, 500, PAGE('Something went wrong', 'We couldn\'t record your unsubscribe right now. Please try again in a moment.'));
  } finally {
    if (client) client.release();
  }
};
