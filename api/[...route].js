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

const ROUTES = {
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

  return handler(req, res);
};
