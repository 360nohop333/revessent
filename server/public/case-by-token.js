// Revessent /api/public/case-by-token
// Public endpoint for customer payment update page (pay.html).
// Resolves a secure checkout_token to minimal public invoice data needed by Razorpay Checkout.js.
// No Supabase auth required.

const { Pool } = require('pg');

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

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  // Parse token from query
  const query = (req.url && req.url.includes('?')) ? req.url.split('?')[1] : '';
  const searchParams = new URLSearchParams(query);
  const token = cleanString(searchParams.get('token') || (req.query && req.query.token));

  if (!token) {
    return sendJson(res, 400, { error: 'token parameter is required.' });
  }

  let client;
  try {
    client = await pool.connect();

    const result = await client.query(
      `select rc.id, rc.amount_cents, rc.currency, rc.status, rc.checkout_expires_at,
              org.name as org_name,
              vp.brand_name,
              sc.stripe_account_id as razorpay_key_id
         from recovery_cases rc
         join organizations org on org.id = rc.organization_id
         left join voice_profiles vp on vp.organization_id = org.id and vp.is_default = true
         left join stripe_connections sc on sc.organization_id = org.id and sc.is_active = true
        where rc.checkout_token = $1
          and rc.checkout_expires_at is not null
          and rc.checkout_expires_at > now()
          and rc.status not in ('recovered', 'lost', 'canceled')
        limit 1`,
      [token]
    );

    const row = result.rows[0];
    if (!row) {
      return sendJson(res, 404, { error: 'This payment link has expired or is invalid.' });
    }

    const brandName = cleanString(row.brand_name) || cleanString(row.org_name) || 'Subscription Service';
    const razorpayKeyId = cleanString(row.razorpay_key_id) || cleanString(process.env.RAZORPAY_KEY_ID);

    return sendJson(res, 200, {
      amountCents: row.amount_cents,
      currency: row.currency || 'INR',
      brandName,
      razorpayKeyId,
    });
  } catch (error) {
    console.error('Revessent /api/public/case-by-token error:', error);
    return sendJson(res, 500, { error: 'Could not retrieve payment case.' });
  } finally {
    if (client) client.release();
  }
};
