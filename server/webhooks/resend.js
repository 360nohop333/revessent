// Revessent /api/webhooks/resend (audit #37) — delivery webhooks from Resend.
// Bounces and complaints land in suppression_list automatically, so a hard
// bounce stops future sends without anyone doing it by hand.
//
// Signature: Resend uses Svix — headers `svix-id`, `svix-timestamp`,
// `svix-signature` (one or more `v1,base64sig` entries, plus an optional
// `v1a` unencoded variant). Signed content is `${id}.${timestamp}.${rawBody}`
// HMAC-SHA256'd with the signing secret (RESEND_WEBHOOK_SECRET, the "whsec_…"
// value from Resend → Webhooks). Requests older than 5 minutes are rejected.
//
// Org mapping: send-note tags every outgoing email with `org:<id>` and
// `member:<id>`; the bounce/complaint handler reads them back.

const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1, // audit #45
  ssl: { rejectUnauthorized: false },
});

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function getSigningSecret() {
  const secret = String(process.env.RESEND_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    const error = new Error('Resend webhooks are not configured.');
    error.statusCode = 503;
    throw error;
  }
  // Svix secrets are handed out as whsec_<base64>; the HMAC key is the
  // base64-decoded bytes.
  const raw = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  return Buffer.from(raw, 'base64');
}

function verifySvixSignature(rawBody, headers, secret) {
  const id = String(headers['svix-id'] || '');
  const timestamp = String(headers['svix-timestamp'] || '');
  const signatureHeader = String(headers['svix-signature'] || '');

  if (!id || !timestamp || !signatureHeader) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false; // 5-minute tolerance

  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signedContent).digest('base64');

  return signatureHeader
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => {
      const [version, ...rest] = part.split(',');
      const given = rest.join(',');
      if (version !== 'v1' || !given) return false;
      try {
        // Both sides base64; compare digests timing-safely.
        const a = crypto.createHash('sha256').update(given).digest();
        const b = crypto.createHash('sha256').update(expected).digest();
        return crypto.timingSafeEqual(a, b);
      } catch (_) {
        return false;
      }
    });
}

async function suppressBounce(client, { organizationId, email, memberId, reason }) {
  await client.query(
    `insert into suppression_list (id, organization_id, member_id, email, unsubscribed_at, created_at)
     values ($1, $2, $3, $4, now(), now())
     on conflict (organization_id, lower(email)) do nothing`,
    [crypto.randomUUID(), organizationId, memberId || null, String(email || '').toLowerCase()]
  );
  await client.query(
    `insert into activity_feed
       (id, organization_id, type, title, description, amount_cents, currency, member_id, case_id, metadata, created_at)
     values
       ($1, $2, 'email_suppressed', $3, $4, null, null, $5, null, $6::jsonb, now())`,
    [
      crypto.randomUUID(),
      organizationId,
      reason === 'complaint' ? 'Recipient marked email as spam' : 'Email bounced — recipient suppressed',
      `Resend reported a ${reason} for ${email}. Future recovery emails to this address are blocked.`,
      memberId || null,
      JSON.stringify({ source: 'resend-webhook', reason, email }),
    ]
  );
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let secret;
  try {
    secret = getSigningSecret();
  } catch (error) {
    return sendJson(res, error.statusCode || 503, { error: error.message });
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const rawBody = Buffer.concat(chunks).toString('utf8');

  if (!verifySvixSignature(rawBody, req.headers || {}, secret)) {
    return sendJson(res, 400, { error: 'Invalid signature.' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (_) {
    return sendJson(res, 400, { error: 'Invalid JSON body.' });
  }

  const type = String((event && event.type) || '');
  const data = (event && event.data) || {};

  // { 'email.bounced': true, ... }
  if (type === 'email.bounced' || type === 'email.complained') {
    // Map back to the workspace via the tags send-note attached to the email.
    const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
    const orgTag = tags.find((t) => t.startsWith('org:'));
    const memberTag = tags.find((t) => t.startsWith('member:'));
    const organizationId = orgTag ? orgTag.slice(4) : null;
    const email = String(data.to || data.email || '').trim().toLowerCase();

    if (!organizationId || !email) {
      // Not ours to act on (or an email sent before tagging existed).
      return sendJson(res, 200, { received: true, action: 'unmapped' });
    }

    let client;
    try {
      client = await pool.connect();
      await suppressBounce(client, {
        organizationId,
        email,
        memberId: memberTag ? memberTag.slice(7) : null,
        reason: type === 'email.complained' ? 'complaint' : 'bounce',
      });
      return sendJson(res, 200, { received: true, action: 'suppressed' });
    } catch (error) {
      console.error('Revessent /api/webhooks/resend failed:', error);
      return sendJson(res, 500, { error: 'Could not record the bounce.' }); // Resend retries
    } finally {
      if (client) client.release();
    }
  }

  // email.sent / email.delivered / email.opened / email.clicked —
  // acknowledged; no action needed today.
  return sendJson(res, 200, { received: true, action: 'ignored', type });
};
