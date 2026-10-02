// Revessent — single API function (audit #68)
//
// Vercel's Hobby plan caps a deployment at 12 Serverless Functions, and this
// project grew to 23 endpoint files — every deploy was failing with
// exceeded_serverless_functions_per_deployment. All handlers now live in
// /server (plain Node modules, NOT auto-deployed as functions) and this ONE
// catch-all routes every /api/* URL to them. Public URLs are unchanged.
//
// To add an endpoint: create server/<path>.js exporting (req, res), then add
// it to the ROUTES map below (static requires so the bundler includes it).
// Modules under server/_lib/ are shared helpers — they are NOT routable.

const ROUTES = {
  'health': require('../server/health.js'),
  'leads': require('../server/leads.js'),
  'unsubscribe': require('../server/unsubscribe.js'),
  'config.js': require('../server/config.js'),
  'me': require('../server/me.js'),
  'settings': require('../server/settings.js'),
  'members': require('../server/members.js'),
  'dashboard-data': require('../server/dashboard-data.js'),
  'onboard': require('../server/onboard.js'),
  'organization': require('../server/organization.js'),
  'digests': require('../server/digests.js'),
  'keys': require('../server/keys.js'),
  'changelog': require('../server/changelog.js'),
  'referrals': require('../server/referrals.js'),
  'audit': require('../server/audit.js'),
  'recovery/case': require('../server/recovery/case.js'),
  'recovery/retry': require('../server/recovery/retry.js'),
  'recovery/send-note': require('../server/recovery/send-note.js'),
  'recovery/send-sms': require('../server/recovery/send-sms.js'),
  'recovery/bulk-approve': require('../server/recovery/bulk-approve.js'),
  'razorpay/connect': require('../server/razorpay/connect.js'),
  'razorpay/backfill': require('../server/razorpay/backfill.js'),
  'webhooks/razorpay': require('../server/webhooks/razorpay.js'),
  'webhooks/resend': require('../server/webhooks/resend.js'),
  'webhooks/sms-inbound': require('../server/webhooks/sms-inbound.js'),
  'webhooks/replay': require('../server/webhooks/replay.js'),
  'cron/process-recovery-queue': require('../server/cron/process-recovery-queue.js'),
  'alerts/send': require('../server/alerts/send.js'),
  'alerts/test': require('../server/alerts/test.js'),
  'export/cases': require('../server/export/cases.js'),
  'export/members': require('../server/export/members.js'),
  'v1/dashboard-summary': require('../server/v1/dashboard-summary.js'),
};

// ── Rate limiting (audit #10) ─────────────────────────────────────────────
// Two tiers:
//  - DURABLE (preferred): with UPSTASH_REDIS_REST_URL + _TOKEN set, a fixed
//    window counter in Upstash Redis — enforced across ALL instances.
//  - IN-MEMORY (fallback): sliding window per warm instance. Better than
//    nothing when no Redis is configured, or if Redis is unreachable
//    (availability wins over strictness — a limiter outage must not 500 the
//    app).
// Webhooks (Razorpay, Resend) and the cron authenticate with their own
// secrets and are exempt.
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX = 30; // requests per window per IP per route
const rateBuckets = new Map(); // in-memory fallback store

function clientIp(req) {
  const fwd = req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For']) || '';
  const first = String(fwd).split(',')[0].trim();
  if (first) return first;
  return String((req.headers && (req.headers['x-real-ip'] || req.headers['X-Real-Ip'])) || 'unknown');
}

function inMemoryLimited(key) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket) {
    bucket = [];
    rateBuckets.set(key, bucket);
  }
  while (bucket.length && now - bucket[0] > RATE_LIMIT_WINDOW_SECONDS * 1000) bucket.shift();
  if (bucket.length >= RATE_LIMIT_MAX) return true;
  bucket.push(now);
  // crude memory cap so a flood of unique IPs can't grow the map forever
  if (rateBuckets.size > 5000) rateBuckets.clear();
  return false;
}

// Audit #10: Upstash REST pipeline — INCR + EXPIRE in one round trip.
async function upstashLimited(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null; // not configured → caller uses in-memory

  const windowId = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS);
  const redisKey = `rl:${key}:${windowId}`;

  try {
    const response = await fetch(String(url).replace(/\/+$/, '') + '/pipeline', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['INCR', redisKey],
        ['EXPIRE', redisKey, String(RATE_LIMIT_WINDOW_SECONDS * 2)],
      ]),
    });
    if (!response.ok) return null; // fall back — never block on Redis trouble
    const body = await response.json();
    const count = Number(body && body[0] && body[0].result);
    if (!Number.isFinite(count)) return null;
    return count > RATE_LIMIT_MAX;
  } catch (_) {
    return null; // network error → fall back to in-memory
  }
}

async function rateLimited(key) {
  const durable = await upstashLimited(key);
  if (durable !== null) return durable;
  return inMemoryLimited(key);
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  // req.url arrives as the full path: /api/<route>?<query>
  const pathname = String(req.url || '')
    .split('?')[0]
    .replace(/^\/api\//i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();

  const handler = ROUTES[pathname];

  if (!handler) {
    return sendJson(res, 404, { error: 'Not found.' });
  }

  // Rate-limit writes + the public token endpoint. Webhooks (Razorpay,
  // Resend) and the cron authenticate with their own secrets and are exempt.
  const isWrite = req.method === 'POST' || req.method === 'DELETE' || req.method === 'PUT';
  const exempt =
    pathname === 'webhooks/razorpay' ||
    pathname === 'webhooks/resend' ||
    pathname === 'webhooks/sms-inbound' || // signature-authenticated (Twilio)
    pathname === 'cron/process-recovery-queue';
  if (isWrite && !exempt) {
    if (await rateLimited(`${clientIp(req)}|${pathname}|write`)) {
      return sendJson(res, 429, { error: 'Too many requests — please slow down.' });
    }
  }

  return handler(req, res);
};
