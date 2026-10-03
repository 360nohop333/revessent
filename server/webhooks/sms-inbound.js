// Revessent /api/webhooks/sms-inbound (2nd-opinion #16) — Twilio inbound
// webhook for SMS opt-out. A customer replying STOP (or the standard opt-out
// keywords) is suppressed from all recovery SMS in every workspace that has
// their phone on file; START/UNSTOP re-enables.
//
// Signature: Twilio's X-Twilio-Signature — base64(HMAC-SHA1(url + sorted
// param pairs concatenated, TWILIO_AUTH_TOKEN)). The URL must be the FULL
// public URL; behind Vercel we rebuild it from PUBLIC_APP_URL + req.url.
//
// Responds with empty 204 — Twilio doesn't need a TwiML body for a plain
// opt-out (no reply is sent; the confirmation requirement depends on your
// DLT template and is deliberately NOT auto-replied here).

const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1, // audit #45
  ssl: { rejectUnauthorized: false },
});

const STOP_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout']);
const START_KEYWORDS = new Set(['start', 'unstop', 'yes', 'optin']);

function publicUrl(req) {
  const base = (
    process.env.PUBLIC_APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : '') ||
    'https://revessent-alpha.vercel.app'
  ).replace(/\/+$/, '');
  return base + String(req.url || '');
}

function verifyTwilioSignature(url, params, signature, authToken) {
  if (!signature || !authToken) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  const a = crypto.createHash('sha256').update(signature).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? digits : (digits ? '+' + digits : '');
}

async function readFormBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  const params = {};
  new URLSearchParams(raw).forEach((v, k) => { params[k] = v; });
  return params;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.statusCode = 405;
    return res.end();
  }

  const authToken = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
  if (!authToken) {
    res.statusCode = 503;
    return res.end();
  }

  let params;
  try {
    params = await readFormBody(req);
  } catch (_) {
    res.statusCode = 400;
    return res.end();
  }

  const signature = String((req.headers && (req.headers['x-twilio-signature'] || req.headers['X-Twilio-Signature'])) || '');
  if (!verifyTwilioSignature(publicUrl(req), params, signature, authToken)) {
    res.statusCode = 403;
    return res.end();
  }

  const phone = normalizePhone(params.From);
  const keyword = String(params.Body || '').trim().toLowerCase();

  if (!phone || !(STOP_KEYWORDS.has(keyword) || START_KEYWORDS.has(keyword))) {
    res.statusCode = 204; // not an opt-out/opt-in — nothing to do
    return res.end();
  }

  let client;
  try {
    client = await pool.connect();

    if (STOP_KEYWORDS.has(keyword)) {
      // Suppress in EVERY workspace holding this phone: a customer texting
      // STOP means STOP, regardless of which workspace's case triggered the
      // message. Uses the member rows to find org + member ids.
      await client.query(
        `insert into suppression_list (id, organization_id, member_id, email, phone, unsubscribed_at, created_at)
         select $1, sm.organization_id, sm.id, coalesce(sm.email, ''), $2, now(), now()
           from stripe_members sm
          where sm.phone = $2 or sm.phone = ltrim($2, '+') or ('+' || regexp_replace(sm.phone, '\\D', '', 'g')) = $2
         on conflict (organization_id, lower(email)) do update
           set phone = excluded.phone,
               unsubscribed_at = now()`,
        [crypto.randomUUID(), phone]
      );
    } else {
      await client.query(
        `delete from suppression_list where phone = $1 or phone = ltrim($1, '+')`,
        [phone]
      );
    }

    res.statusCode = 204;
    return res.end();
  } catch (error) {
    console.error('Revessent /api/webhooks/sms-inbound failed:', error);
    res.statusCode = 500; // Twilio retries
    return res.end();
  } finally {
    if (client) client.release();
  }
};
