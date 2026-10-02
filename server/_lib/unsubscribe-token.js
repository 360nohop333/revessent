// Revessent unsubscribe tokens (audit #35).
// Stateless HMAC tokens: base64url(payload) + '.' + base64url(hmac-sha256).
// Signed with ENCRYPTION_KEY (already required) — no new env vars.

const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function secret() {
  const s = String(process.env.ENCRYPTION_KEY || '').trim();
  if (!s) throw new Error('ENCRYPTION_KEY is not configured.');
  return s;
}

function createUnsubscribeToken(organizationId, memberId, email) {
  const payload = b64url(JSON.stringify({ o: organizationId, m: memberId, e: email }));
  const sig = b64url(crypto.createHmac('sha256', secret()).update(payload).digest());
  return payload + '.' + sig;
}

function verifyUnsubscribeToken(token) {
  try {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return null;
    const expected = crypto.createHmac('sha256', secret()).update(payload).digest();
    const given = Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!data || !data.o || !data.e) return null;
    return { organizationId: String(data.o), memberId: data.m ? String(data.m) : null, email: String(data.e) };
  } catch (_) {
    return null;
  }
}

function appBaseUrl() {
  return (
    process.env.PUBLIC_APP_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    'https://revessent-alpha.vercel.app'
  ).replace(/\/+$/, '');
}

module.exports = { createUnsubscribeToken, verifyUnsubscribeToken, appBaseUrl };
