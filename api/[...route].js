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
  'recovery/case': require('../server/recovery/case.js'),
  'recovery/retry': require('../server/recovery/retry.js'),
  'recovery/send-note': require('../server/recovery/send-note.js'),
  'recovery/send-sms': require('../server/recovery/send-sms.js'),
  'razorpay/connect': require('../server/razorpay/connect.js'),
  'razorpay/backfill': require('../server/razorpay/backfill.js'),
  'webhooks/razorpay': require('../server/webhooks/razorpay.js'),
  'cron/process-recovery-queue': require('../server/cron/process-recovery-queue.js'),
  'alerts/send': require('../server/alerts/send.js'),
  'alerts/test': require('../server/alerts/test.js'),
  'export/cases': require('../server/export/cases.js'),
  'export/members': require('../server/export/members.js'),
  'v1/dashboard-summary': require('../server/v1/dashboard-summary.js'),
};

// ── Rate limiting (audit #10, partial) ─────────────────────────────────────
// In-memory sliding window per warm instance. NOT a durable limit — Vercel
// may run many instances — but it meaningfully throttles abuse hitting a hot
// instance and costs zero dependencies. A durable limit (Upstash/Vercel KV)
// stays on the roadmap; the router is the single place to swap it in.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30; // requests per window per IP per route
const rateBuckets = new Map();

function clientIp(req) {
  const fwd = req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For']) || '';
  const first = String(fwd).split(',')[0].trim();
  if (first) return first;
  return String((req.headers && (req.headers['x-real-ip'] || req.headers['x-real-ip'])) || 'unknown');
}

function rateLimited(key) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket) {
    bucket = [];
    rateBuckets.set(key, bucket);
  }
  while (bucket.length && now - bucket[0] > RATE_LIMIT_WINDOW_MS) bucket.shift();
  if (bucket.length >= RATE_LIMIT_MAX) return true;
  bucket.push(now);
  // crude memory cap so a flood of unique IPs can't grow the map forever
  if (rateBuckets.size > 5000) rateBuckets.clear();
  return false;
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

  // Rate-limit writes + the public token endpoint. Webhooks (Razorpay) and
  // the cron authenticate with their own secrets and are exempt.
  const isWrite = req.method === 'POST' || req.method === 'DELETE' || req.method === 'PUT';
  const exempt = pathname === 'webhooks/razorpay' || pathname === 'cron/process-recovery-queue';
  if (isWrite && !exempt) {
    if (rateLimited(`${clientIp(req)}|${pathname}|write`)) {
      return sendJson(res, 429, { error: 'Too many requests — please slow down.' });
    }
  }

  return handler(req, res);
};
