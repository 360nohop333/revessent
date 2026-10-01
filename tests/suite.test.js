// Revessent offline test suite (no DB, no network).
// Run: npm install && npm test   (or: node tests/suite.test.js)
//
// Everything DB-touching is mocked: pg.Pool is replaced before any server
// module is required, and global fetch is stubbed for Supabase auth calls,
// Razorpay API calls, Slack/Discord webhooks and Gemini.
'use strict';

const path = require('path').resolve(__dirname, '..');
const crypto = require('crypto');

let failures = 0;
let passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log('PASS  ' + name); }
  else { failures++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}
function makeRes() {
  return {
    statusCode: 0, headers: {}, raw: null, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(str) { this.raw = str; if (str == null) { this.body = null; return; } try { this.body = JSON.parse(str); } catch (_) { this.body = null; } },
  };
}
function makeReq(method, { headers = {}, query = '', body } = {}) {
  const parsed = {};
  new URLSearchParams(query.replace(/^\?/, '')).forEach((v, k) => { parsed[k] = v; });
  return {
    method, url: '/api/x' + query, query: parsed, headers,
    [Symbol.asyncIterator]: async function* () { if (body != null) yield Buffer.from(body); },
  };
}
async function call(handler, req) {
  const res = makeRes();
  await handler(req, res);
  return res;
}

// ── pg stub ───────────────────────────────────────────────────────────────────
const pg = require(path + '/node_modules/pg');
let CURRENT_CLIENT = null;
pg.Pool = class { constructor() {} async connect() { return CURRENT_CLIENT; } };

// ── fetch mock ────────────────────────────────────────────────────────────────
let SUPABASE_USER = { id: 'sbu-1', email: 'owner@test.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
let WEBHOOK_RESPONDS = { ok: true, status: 200 };
let FETCH_LOG = [];
const realFetch = global.fetch;
global.fetch = async (url, options) => {
  FETCH_LOG.push({ url: String(url), options });
  if (String(url).includes('/auth/v1/user')) {
    if (!SUPABASE_USER) return { ok: false, status: 401, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => SUPABASE_USER };
  }
  return { ok: WEBHOOK_RESPONDS.ok, status: WEBHOOK_RESPONDS.status, json: async () => ({}) };
};
function webhookCalls() { return FETCH_LOG.filter((e) => !String(e.url).includes('/auth/v1/user')); }

const USERS_ROW = { id: 'user-1', organization_id: 'org-1', email: 'owner@test.com', role: 'owner', supabase_user_id: 'sbu-1' };
const MEMBER_ROW = { id: 'member-1', organization_id: 'org-1', email: 'a@b.com', name: 'A' };
const AUTH = { authorization: 'Bearer tok' };

// shared fake-DB router used by most endpoint tests
function fakeClient(routes) {
  return {
    release() {},
    async query(sql, params) {
      const s = String(sql).trim();
      const l = s.toLowerCase();
      for (const [pattern, fn] of routes) {
        if (pattern.test(l) || pattern.test(s)) return fn({ sql: s, l, params });
      }
      throw new Error('unexpected query: ' + l.replace(/\s+/g, ' ').slice(0, 110));
    },
  };
}
const TXN = [/^(begin|commit|rollback)/, () => ({ rows: [] })];
const SAVEPOINT = [/^(savepoint|release savepoint|rollback to savepoint)/, () => ({ rows: [] })];
const AUTH_BY_SBUID = [/from users\s+where supabase_user_id/, ({ params }) => ({ rows: params[0] === 'sbu-1' ? [USERS_ROW] : [] })];

// ═══════════════════════════════════════════════════════════════════════════════
async function testRouter() {
  console.log('\n── single-function router (audit #68) ──');
  const router = require(path + '/api/[...route].js');

  CURRENT_CLIENT = fakeClient([
    TXN, SAVEPOINT, AUTH_BY_SBUID,
    [/from stripe_connections/, () => ({ rows: [{ organization_id: 'org-1', webhook_secret: 'whsec_t' }] })],
  ]);
  const res = await call(router, { method: 'GET', url: '/api/settings?organizationId=org-1', query: { organizationId: 'org-1' }, headers: AUTH });
  check('router: /api/settings dispatches to settings handler', res.statusCode !== 404, JSON.stringify(res.body));

  const res404 = await call(router, makeReq('GET', { query: '' }));
  check('router: unknown route → 404', res404.statusCode === 404, JSON.stringify(res404.body));

  const fs = require('fs');
  const count = fs.readdirSync(path + '/api').filter((f) => f.endsWith('.js')).length;
  check('router: exactly ONE file under api/ (Hobby cap is 12)', count === 1, 'api/ has ' + count + ' files');
  check('router: handlers live in server/', fs.existsSync(path + '/server/me.js'));
}

// ═══════════════════════════════════════════════════════════════════════════════
async function testOnboardSecurity() {
  console.log('\n── onboard security (audit #1/#2) ──');
  const onboard = require(path + '/server/onboard.js');

  const baseRoutes = [
    TXN, SAVEPOINT,
    [/from users\s+where supabase_user_id/, () => ({ rows: [] })],
    [/from users\s+where lower\(email\)/, () => ({ rows: [] })],
    [/insert into organizations/, () => ({ rows: [] })],
    [/select 1[\s\S]*referral_code = \$1/, () => ({ rows: [] })],
    [/update organizations[\s\S]*set referral_code/, () => ({ rows: [{}] })],
    [/insert into referrals/, () => ({ rows: [] })],
    [/insert into users/, ({ params }) => ({ rows: [{ id: 'new-user', organization_id: params[1], email: params[2], role: 'owner', supabase_user_id: params[3] }] })],
  ];

  // no token → 401 (identity can no longer come from the body)
  CURRENT_CLIENT = fakeClient(baseRoutes);
  let res = await call(onboard, makeReq('POST', { body: JSON.stringify({ email: 'attacker@evil.com', supabaseUserId: 'sbu-victim' }) }));
  check('onboard: no token → 401', res.statusCode === 401, JSON.stringify(res.body));

  // with token → identity comes from Supabase, NOT the body
  SUPABASE_USER = { id: 'sbu-new', email: 'real@supabase.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
  let insertedUser = null;
  CURRENT_CLIENT = fakeClient(baseRoutes.map((r) =>
    r[0].source === 'insert into users' ? [r[0], ({ params }) => { insertedUser = params; return { rows: [{ id: 'new-user', organization_id: params[1], email: params[2], role: 'owner', supabase_user_id: params[3] }] }; }] : r
  ));
  res = await call(onboard, makeReq('POST', {
    headers: AUTH,
    body: JSON.stringify({ email: 'attacker@evil.com', supabaseUserId: 'sbu-victim' }),
  }));
  check('onboard: token wins — body email/userId ignored', res.statusCode === 200 && insertedUser[2] === 'real@supabase.com' && insertedUser[3] === 'sbu-new', JSON.stringify(insertedUser));

  // email linking requires a confirmed email (audit #2)
  SUPABASE_USER = { id: 'sbu-2', email: 'victim@real.com', email_confirmed_at: null };
  CURRENT_CLIENT = fakeClient([
    TXN,
    [/from users\s+where supabase_user_id/, () => ({ rows: [] })],
    [/from users\s+where lower\(email\)/, () => ({ rows: [{ id: 'user-victim', organization_id: 'org-x', email: 'victim@real.com', role: 'owner', supabase_user_id: null }] })],
  ]);
  res = await call(onboard, makeReq('POST', { headers: AUTH, body: '{}' }));
  check('onboard: unconfirmed email cannot claim unlinked account → 403', res.statusCode === 403, JSON.stringify(res.body));

  SUPABASE_USER = { id: 'sbu-2', email: 'victim@real.com', email_confirmed_at: '2026-02-02T00:00:00Z' };
  let backfilled = null;
  CURRENT_CLIENT = fakeClient([
    TXN,
    [/from users\s+where supabase_user_id/, () => ({ rows: [] })],
    [/from users\s+where lower\(email\)/, () => ({ rows: [{ id: 'user-victim', organization_id: 'org-x', email: 'victim@real.com', role: 'owner', supabase_user_id: null }] })],
    [/update users[\s\S]*supabase_user_id = \$1/, ({ params }) => { backfilled = params; return { rows: [{ id: 'user-victim', organization_id: 'org-x', email: 'victim@real.com', role: 'owner', supabase_user_id: params[0] }] }; }],
  ]);
  res = await call(onboard, makeReq('POST', { headers: AUTH, body: '{}' }));
  check('onboard: confirmed email links account', res.statusCode === 200 && backfilled && backfilled[0] === 'sbu-2', JSON.stringify(res.body));

  SUPABASE_USER = { id: 'sbu-1', email: 'owner@test.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
}

// ═══════════════════════════════════════════════════════════════════════════════
async function testRoleGates() {
  console.log('\n── role gates (audit #4) ──');
  const memberRow = { ...USERS_ROW, role: 'member' };

  const gate = async (modName, method, reqOpts) => {
    const mod = require(path + '/server/' + modName + '.js');
    CURRENT_CLIENT = fakeClient([
      [/from users\s+where supabase_user_id/, () => ({ rows: [memberRow] })],
    ]);
    return call(mod, makeReq(method, { headers: AUTH, ...reqOpts }));
  };

  let res = await gate('razorpay/connect', 'POST', { body: '{}' });
  check('connect: member → 403', res.statusCode === 403, JSON.stringify(res.body));
  res = await gate('recovery/retry', 'POST', { body: JSON.stringify({ caseId: 'c1' }) });
  check('retry: member → 403', res.statusCode === 403, JSON.stringify(res.body));
  res = await gate('recovery/send-note', 'POST', { body: JSON.stringify({ caseId: 'c1' }) });
  check('send-note: member → 403', res.statusCode === 403, JSON.stringify(res.body));
  res = await gate('recovery/send-sms', 'POST', { body: JSON.stringify({ caseId: 'c1' }) });
  check('send-sms: member → 403', res.statusCode === 403, JSON.stringify(res.body));
  res = await gate('keys', 'POST', { body: '{}' });
  check('keys POST: member → 403', res.statusCode === 403, JSON.stringify(res.body));
  res = await gate('alerts/test', 'POST', { body: '{}' });
  check('alerts/test: member → 403', res.statusCode === 403, JSON.stringify(res.body));

  // owner still passes (proceed past the gate)
  CURRENT_CLIENT = fakeClient([
    [/from users\s+where supabase_user_id/, () => ({ rows: [USERS_ROW] })],
    [/select alert_webhook_url/, () => ({ rows: [{ alert_webhook_url: null, alert_min_amount_cents: 0 }] })],
  ]);
  const testAlert = require(path + '/server/alerts/test.js');
  res = await call(testAlert, makeReq('POST', { headers: AUTH, body: '{}' }));
  check('alerts/test: owner passes gate (reaches no-webhook 400)', res.statusCode === 400, JSON.stringify(res.body));
}

// ═══════════════════════════════════════════════════════════════════════════════
async function testSettings() {
  console.log('\n── settings (audit #5 sender blocklist, alert persistence) ──');
  const settings = require(path + '/server/settings.js');

  let orgRow = { alert_webhook_url: 'https://hooks.slack.com/services/abc', alert_min_amount_cents: 15000 };
  const routes = () => [
    TXN,
    [/from users\s+where supabase_user_id/, () => ({ rows: [USERS_ROW] })],
    [/from stripe_connections/, () => ({ rows: [] })],
    [/from voice_profiles[\s\S]*organization_id/, () => ({ rows: [] })],
    [/insert into voice_profiles/, () => ({ rows: [] })],
    [/update voice_profiles[\s\S]*set /, () => ({ rows: [] })],
    [/select alert_webhook_url/, () => ({ rows: [orgRow] })],
    [/update organizations[\s\S]*set alert_webhook_url/, ({ params }) => {
      orgRow = {
        ...orgRow,
        alert_webhook_url: params[1] === null ? orgRow.alert_webhook_url : (params[1] === '' ? null : params[1]),
        alert_min_amount_cents: params[2] == null ? orgRow.alert_min_amount_cents : params[2],
      };
      return { rows: [] };
    }],
  ];

  CURRENT_CLIENT = fakeClient(routes());
  let res = await call(settings, makeReq('GET', { headers: AUTH, query: '?organizationId=org-1' }));
  check('settings GET: alert fields returned', res.statusCode === 200 && res.body.alertWebhookUrl === 'https://hooks.slack.com/services/abc' && res.body.alertMinAmountCents === 15000, JSON.stringify(res.body));

  // audit #5: platform-domain sender rejected
  res = await call(settings, makeReq('POST', { headers: AUTH, body: JSON.stringify({ organizationId: 'org-1', brandName: 'B', senderName: 'S', senderEmail: 'hello@revessent.com', tone: 'professional', smsEnabled: false }) }));
  check('settings POST: @revessent.com sender → 400', res.statusCode === 400, JSON.stringify(res.body));
  res = await call(settings, makeReq('POST', { headers: AUTH, body: JSON.stringify({ organizationId: 'org-1', brandName: 'B', senderName: 'S', senderEmail: 'x@resend.dev', tone: 'professional', smsEnabled: false }) }));
  check('settings POST: @resend.dev sender → 400', res.statusCode === 400, JSON.stringify(res.body));

  res = await call(settings, makeReq('POST', { headers: AUTH, body: JSON.stringify({ organizationId: 'org-1', brandName: 'B', senderName: 'S', senderEmail: 's@own-domain.com', tone: 'professional', smsEnabled: false, alertMinAmount: '250.5' }) }));
  check('settings POST: own-domain sender OK, 250.5 → 25050 cents', res.statusCode === 200 && orgRow.alert_min_amount_cents === 25050, JSON.stringify(orgRow));
}

// ═══════════════════════════════════════════════════════════════════════════════
async function testWebhookMoneyPath() {
  console.log('\n── webhook money path (audit #19/#20/#22 + alerts) ──');
  const webhook = require(path + '/server/webhooks/razorpay.js');
  const SECRET = 'whsec_test';

  let attributions = [];
  let webhookEvents = {}; // eventId -> row
  let processingShouldFail = false;
  const seenPaymentIds = new Set(); // simulates unique index on stripe_invoice_id

  function client() {
    return fakeClient([
      TXN, SAVEPOINT,
      [/from stripe_connections/, () => ({ rows: [{ organization_id: 'org-1', webhook_secret: SECRET }] })],
      [/insert into webhook_events/, ({ params }) => {
        const [id, org, eventId] = params;
        if (webhookEvents[eventId]) return { rows: [] }; // conflict — caller re-selects
        webhookEvents[eventId] = { id, eventId, processed_at: null, processing_error: null };
        return { rows: [{ id }] };
      }],
      [/from webhook_events[\s\S]*stripe_event_id = \$1/, ({ params }) => ({ rows: webhookEvents[params[0]] ? [webhookEvents[params[0]]] : [] })],
      [/update webhook_events/, ({ l, params }) => {
        const row = Object.values(webhookEvents).find((r) => r.id === params[0]);
        if (row) {
          if (l.includes('processing_error = null')) { row.processed_at = new Date(); row.processing_error = null; }
          else if (l.includes('processing_error = $2')) { row.processed_at = new Date(); row.processing_error = String(params[1]); }
        }
        return { rows: [] };
      }],
      [/from stripe_members/, () => ({ rows: [MEMBER_ROW] })],
      [/update stripe_members/, () => ({ rows: [MEMBER_ROW] })],
      [/from stripe_subscriptions/, () => ({ rows: [] })],
      [/from recovery_cases/, ({ l }) => {
        if (l.startsWith('select')) {
          return { rows: clientOpenCase ? [clientOpenCase] : [] };
        }
        return { rows: [] };
      }],
      [/update recovery_cases/, () => ({ rows: [{ id: 'case-open' }] })],
      [/insert into recovery_cases/, ({ params }) => {
        if (seenPaymentIds.has(params[4])) return { rows: [] }; // on conflict do nothing
        seenPaymentIds.add(params[4]);
        return { rows: [{ id: 'case-new' }] };
      }],
      [/insert into recovery_attributions/, ({ params }) => { attributions.push(params); return { rows: [] }; }],
      [/insert into activity_feed/, () => {
        if (processingShouldFail) throw new Error('simulated activity insert failure');
        return { rows: [] };
      }],
      [/select alert_webhook_url/, () => ({ rows: [{ alert_webhook_url: 'https://hooks.slack.com/services/alerts', alert_min_amount_cents: 0 }] })],
    ]);
  }

  let clientOpenCase = null;

  async function post(event, payment, headers = {}) {
    CURRENT_CLIENT = client();
    FETCH_LOG = [];
    const raw = JSON.stringify({ event, payload: { payment: { entity: payment } } });
    const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    return call(webhook, makeReq('POST', {
      headers: { 'x-razorpay-signature': sig, ...headers },
      query: '?org=org-1',
      body: raw,
    }));
  }

  // 1. high-value failure → case + alert
  let res = await post('payment.failed', { id: 'pay_big', amount: 20000, currency: 'INR', status: 'failed', error_code: 'card_declined_by_bank', email: 'a@b.com' }, { 'x-razorpay-event-id': 'evt-big-1' });
  check('webhook: high-value failure → 200 + case_created', res.statusCode === 200 && res.body.action === 'case_created', JSON.stringify(res.body));
  let calls = webhookCalls();
  check('webhook: ⚠️ high-value alert fired post-commit', calls.length === 1 && JSON.parse(calls[0].options.body).text === '⚠️ High-value payment failed — INR 200', JSON.stringify(calls.map((c) => c.options.body)));
  check('webhook: alert stripped from response', !('alert' in res.body), JSON.stringify(res.body));

  // 2. a DIFFERENT event carrying the same payment id → case-level dedupe
  res = await post('payment.failed', { id: 'pay_big', amount: 20000, currency: 'INR', status: 'failed', error_code: 'card_declined_by_bank', email: 'a@b.com' }, { 'x-razorpay-event-id': 'evt-big-2' });
  check('webhook: same payment id under a new event → case_duplicate', res.statusCode === 200 && res.body.action === 'case_duplicate', JSON.stringify(res.body));
  // 2b. the SAME event id redelivered → webhook-level dedupe
  res = await post('payment.failed', { id: 'pay_big', amount: 20000, currency: 'INR', status: 'failed', error_code: 'card_declined_by_bank', email: 'a@b.com' }, { 'x-razorpay-event-id': 'evt-big-1' });
  check('webhook: same event id redelivered → duplicate:true', res.statusCode === 200 && res.body.duplicate === true, JSON.stringify(res.body));

  // 3. small failure → no alert
  res = await post('payment.failed', { id: 'pay_small', amount: 5000, currency: 'INR', status: 'failed', error_code: 'card_declined_by_bank', email: 'a@b.com' });
  check('webhook: small failure → no alert', res.statusCode === 200 && webhookCalls().length === 0);

  // 4. capture on open case → recovered + ATTRIBUTION row (audit #22)
  attributions = [];
  clientOpenCase = { id: 'case-open', member_id: 'member-1', amount_cents: 25000, currency: 'INR' };
  res = await post('payment.captured', { id: 'pay_cap', amount: 25000, currency: 'INR', status: 'captured', email: 'a@b.com' });
  check('webhook: capture → case_recovered', res.statusCode === 200 && res.body.action === 'case_recovered', JSON.stringify(res.body));
  check('webhook: attribution ledger written (audit #22)', attributions.length === 1 && attributions[0][1] === 'org-1' && attributions[0][2] === 'case-open' && attributions[0][4] === 25000, JSON.stringify(attributions));
  calls = webhookCalls();
  check('webhook: 💰 recovery alert fired', calls.length === 1 && JSON.parse(calls[0].options.body).text === '💰 Payment recovered — INR 250', JSON.stringify(calls.map((c) => c.options.body)));

  // 5. fresh success (no open case) → ignored, no attribution
  attributions = [];
  clientOpenCase = null;
  res = await post('payment.captured', { id: 'pay_fresh', amount: 25000, currency: 'INR', status: 'captured', email: 'a@b.com' });
  check('webhook: fresh success ignored, no attribution', res.statusCode === 200 && res.body.action === 'fresh_success_ignored' && attributions.length === 0, JSON.stringify(res.body));

  // 6. audit #20: processing failure → 500 (so Razorpay retries)
  processingShouldFail = true;
  res = await post('payment.failed', { id: 'pay_err', amount: 9000, currency: 'INR', status: 'failed', error_code: 'card_declined_by_bank', email: 'a@b.com' });
  check('webhook: processing failure → 500 (Razorpay will retry)', res.statusCode === 500, 'status=' + res.statusCode);
  processingShouldFail = false;

  // 7. audit #20 + #19: the RETRY of the errored event reprocesses instead of deduping.
  // (The failed run rolled back to its savepoint, so the case insert never
  // committed — mirror that in the fake.)
  seenPaymentIds.delete('pay_err');
  res = await post('payment.failed', { id: 'pay_err', amount: 9000, currency: 'INR', status: 'failed', error_code: 'card_declined_by_bank', email: 'a@b.com' });
  check('webhook: errored event reprocessed on retry (not deduped)', res.statusCode === 200 && res.body.action === 'case_created', JSON.stringify(res.body));

  // 8. audit #19: x-razorpay-event-id header drives dedupe
  const raw = JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_hdr', amount: 9000, currency: 'INR', status: 'failed', error_code: 'x', email: 'a@b.com' } } } });
  const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  CURRENT_CLIENT = client(); FETCH_LOG = [];
  await call(webhook, makeReq('POST', { headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt-custom-1' }, query: '?org=org-1', body: raw }));
  check('webhook: x-razorpay-event-id stored as event id', Boolean(webhookEvents['evt-custom-1']), Object.keys(webhookEvents).join(','));
  CURRENT_CLIENT = client(); FETCH_LOG = [];
  res = await call(webhook, makeReq('POST', { headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt-custom-1' }, query: '?org=org-1', body: raw }));
  check('webhook: same header id → duplicate', res.statusCode === 200 && res.body.duplicate === true, JSON.stringify(res.body));

  // 9. bad signature → 400
  CURRENT_CLIENT = client();
  res = await call(webhook, makeReq('POST', { headers: { 'x-razorpay-signature': 'deadbeef' }, query: '?org=org-1', body: '{}' }));
  check('webhook: bad signature → 400', res.statusCode === 400, JSON.stringify(res.body));
}

// ═══════════════════════════════════════════════════════════════════════════════
async function testRetryGuards() {
  console.log('\n── retry guards (audit #30/#31) ──');
  const retry = require(path + '/server/recovery/retry.js');

  // case not eligible (already recovered) → 400 (audit #30)
  CURRENT_CLIENT = fakeClient([
    [/from users\s+where supabase_user_id/, () => ({ rows: [USERS_ROW] })],
    [/from recovery_cases[\s\S]*where id = \$1/, () => ({ rows: [{ id: 'c1', organization_id: 'org-1', status: 'recovered', retry_count: 1, max_retries: 3 }] })],
  ]);
  let res = await call(retry, makeReq('POST', { headers: AUTH, body: JSON.stringify({ caseId: 'c1' }) }));
  check('retry: recovered case → 400 not eligible', res.statusCode === 400, JSON.stringify(res.body));

  // audit #31: infrastructure failure (no Razorpay response body) on the last
  // attempt must NOT mark the case lost.
  let caseUpdates = [];
  CURRENT_CLIENT = fakeClient([
    TXN,
    [/from users\s+where supabase_user_id/, () => ({ rows: [USERS_ROW] })],
    [/from recovery_cases[\s\S]*where id = \$1/, () => ({ rows: [{ id: 'c1', organization_id: 'org-1', status: 'retrying', retry_count: 2, max_retries: 3, amount_cents: 5000, currency: 'INR', member_id: 'member-1', decline_code: 'card_declined' }] })],
    [/from recovery_attempts[\s\S]*idempotency_key = \$2/, () => ({ rows: [] })],
    [/insert into recovery_attempts/, () => ({ rows: [] })],
    [/update recovery_attempts/, () => ({ rows: [] })],
    [/update recovery_cases/, ({ sql }) => { caseUpdates.push(sql); return { rows: [] }; }],
    [/insert into activity_feed/, () => ({ rows: [] })],
  ]);
  // make the Razorpay call fail with a network-style error (no razorpayBody)
  const realFetchNow = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('api.razorpay.com')) { const e = new Error('ETIMEDOUT'); throw e; }
    if (String(url).includes('/auth/v1/user')) return { ok: true, status: 200, json: async () => SUPABASE_USER };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  res = await call(retry, makeReq('POST', { headers: AUTH, body: JSON.stringify({ caseId: 'c1' }) }));
  global.fetch = realFetchNow;
  const lostUpdate = caseUpdates.find((s) => s.includes("status = 'lost'"));
  check('retry: network failure on final attempt → case NOT lost (audit #31)', !lostUpdate && res.statusCode >= 500, 'lostUpdate=' + Boolean(lostUpdate) + ' status=' + res.statusCode);
}

// ═══════════════════════════════════════════════════════════════════════════════
async function testKeysAndPublic() {
  console.log('\n── api keys / v1 summary / changelog / referrals ──');
  const keys = require(path + '/server/keys.js');
  const summary = require(path + '/server/v1/dashboard-summary.js');
  const changelog = require(path + '/server/changelog.js');

  const keyRows = [];
  CURRENT_CLIENT = fakeClient([
    [/from users\s+where supabase_user_id/, () => ({ rows: [USERS_ROW] })],
    [/insert into api_keys/, ({ params }) => {
      const [id, orgId, keyPrefix, keyHash, label] = params;
      keyRows.push({ id, orgId, keyPrefix, keyHash, label, revoked_at: null, last_used_at: null, created_at: new Date() });
      return { rows: [{ id, key_prefix: keyPrefix }] };
    }],
    [/from api_keys[\s\S]*key_prefix = \$1/, ({ params }) => {
      const row = keyRows.find((r) => r.keyPrefix === params[0] && !r.revoked_at);
      return { rows: row ? [{ id: row.id, organization_id: row.orgId, key_hash: row.keyHash }] : [] };
    }],
    [/update api_keys[\s\S]*revoked_at/, ({ params }) => {
      const row = keyRows.find((r) => r.id === params[0] && r.orgId === params[1] && !r.revoked_at);
      if (row) { row.revoked_at = new Date(); return { rows: [{ id: row.id }] }; }
      return { rows: [] };
    }],
    [/update api_keys[\s\S]*last_used_at/, ({ params }) => { const r = keyRows.find((x) => x.id === params[0]); if (r) r.last_used_at = new Date(); return { rows: [] }; }],
    [/from api_keys[\s\S]*organization_id = \$1/, () => ({ rows: keyRows })],
    [/from recovery_attributions/, () => ({ rows: [{ current_cents: 450000 }] })],
    [/open_case_count/, () => ({ rows: [{ amount_cents: 120000, open_case_count: 3 }] })],
  ]);

  let res = await call(keys, makeReq('POST', { headers: AUTH, body: JSON.stringify({ label: 'Zapier' }) }));
  check('keys: full key returned once, rvsk_ + 32 hex', res.statusCode === 200 && /^rvsk_[0-9a-f]{32}$/.test(res.body.apiKey), JSON.stringify(res.body));
  const fullKey = res.body.apiKey;
  check('keys: sha256 hash stored, not the key', keyRows[0].keyHash === crypto.createHash('sha256').update(fullKey).digest('hex'));

  res = await call(summary, makeReq('GET', { headers: { 'x-api-key': fullKey } }));
  check('v1 summary: valid key → metrics', res.statusCode === 200 && res.body.revenueRecovered.amountCents === 450000 && res.body.revenueAtRisk.openCaseCount === 3, JSON.stringify(res.body));
  res = await call(summary, makeReq('GET', { headers: { 'x-api-key': fullKey.slice(0, 12) + 'f'.repeat(32) } }));
  check('v1 summary: wrong key → 401', res.statusCode === 401, JSON.stringify(res.body));
  res = await call(keys, makeReq('DELETE', { headers: AUTH, body: JSON.stringify({ keyId: keyRows[0].id }) }));
  check('keys: revoke → 200', res.statusCode === 200, JSON.stringify(res.body));
  res = await call(summary, makeReq('GET', { headers: { 'x-api-key': fullKey } }));
  check('v1 summary: revoked key → 401', res.statusCode === 401, JSON.stringify(res.body));

  // changelog public + pre-migration
  CURRENT_CLIENT = fakeClient([[/from changelog_entries/, () => ({ rows: [{ id: 'e1', title: 'T', body: 'B', published_at: new Date('2026-09-20') }] })]]);
  res = await call(changelog, makeReq('GET'));
  check('changelog: public GET', res.statusCode === 200 && res.body.entries.length === 1, JSON.stringify(res.body));
  CURRENT_CLIENT = fakeClient([[/from changelog_entries/, () => { const e = new Error('no table'); e.code = '42P01'; throw e; }]]);
  res = await call(changelog, makeReq('GET'));
  check('changelog: pre-migration → empty entries', res.statusCode === 200 && res.body.entries.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
async function testExports() {
  console.log('\n── CSV exports ──');
  const exportCases = require(path + '/server/export/cases.js');
  const exportMembers = require(path + '/server/export/members.js');

  CURRENT_CLIENT = fakeClient([
    [/from users\s+where supabase_user_id/, () => ({ rows: [USERS_ROW] })],
    [/from recovery_cases rc/, () => ({ rows: [{
      id: 'case-1', member_name: 'Doe, "J" Jr', member_email: 'j@x.com', amount_cents: 123456, currency: 'INR',
      decline_code: 'card_declined', status: 'recovered', retry_count: 2,
      failed_at: new Date('2026-09-01'), recovered_at: new Date('2026-09-03'), recovery_source: 'retry',
    }] })],
  ]);
  let res = await call(exportCases, makeReq('GET', { headers: AUTH }));
  const lines = res.raw.split('\r\n');
  check('cases export: CRLF + escaped quotes', res.statusCode === 200 && lines[1].startsWith('case-1,"Doe, ""J"" Jr",j@x.com'), JSON.stringify(lines[1]));

  CURRENT_CLIENT = fakeClient([
    [/from users\s+where supabase_user_id/, () => ({ rows: [USERS_ROW] })],
    [/from stripe_members sm/, () => ({ rows: [{ name: 'Ann', email: 'a@x.com', sub_status: null, sub_amount_cents: null, lifetime_recovered_cents: null }] })],
  ]);
  res = await call(exportMembers, makeReq('GET', { headers: AUTH }));
  check('members export: nulls → empty (not 0)', res.raw.split('\r\n')[1] === 'Ann,a@x.com,,,', JSON.stringify(res.raw.split('\r\n')[1]));
}

// ═══════════════════════════════════════════════════════════════════════════════
function testSources() {
  console.log('\n── source-level checks ──');
  const fs = require('fs');
  const read = (f) => fs.readFileSync(path + '/' + f, 'utf8');

  // vercel.json valid + headers + single function + daily cron
  const vc = JSON.parse(read('vercel.json'));
  check('vercel.json: valid JSON, security headers present', Array.isArray(vc.headers) && vc.headers[0].headers.length >= 5, JSON.stringify(Object.keys(vc)));
  check('vercel.json: exactly one function configured', Object.keys(vc.functions || {}).length === 1 && Object.keys(vc.functions)[0].includes('[...route]'));
  check('vercel.json: daily cron (Hobby-safe)', vc.crons[0].schedule.split(' ').length === 5 && vc.crons[0].schedule.startsWith('30 3'));

  // no api files besides the router
  check('api/: only the catch-all router', fs.readdirSync(path + '/api').length === 1);

  // gemini key not in URL anywhere (audit #11)
  check('server: Gemini key never in a URL query', !/generateContent\?key=/.test(fs.readdirSync(path + '/server', { recursive: true }).map((f) => { try { return read('server/' + f); } catch (_) { return ''; } }).join('')));
  check('server: GEMINI_MODEL is env-configurable', /process\.env\.GEMINI_MODEL/.test(read('server/recovery/send-note.js')));

  // pools capped (audit #45)
  const pools = fs.readdirSync(path + '/server', { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => read('server/' + f));
  const poolFiles = pools.filter((s) => s.includes('new Pool('));
  check('server: every Pool capped at max:1 (audit #45)', poolFiles.length > 0 && poolFiles.every((s) => /max:\s*1/.test(s)), poolFiles.length + ' pool files');

  // XSS fix (audit #3)
  const dash = read('dashboard.html');
  check('dashboard: aria-labels escape payer names', /function esc\(/.test(dash) && /safeName=esc\(c\.name\)/.test(dash) && !/aria-label="Approve recovery for '\+c\.name/.test(dash));
  check('dashboard: sign-out wired (audit #52)', /signOutBtn/.test(dash) && /auth\.signOut\(\)/.test(dash));
  check('dashboard: 401 redirects to login (audit #53)', /res\.status===401/.test(dash));
  check('dashboard: Cloudflare junk removed (audit #62)', !dash.includes('cdn-cgi/challenge-platform') && !dash.includes('__cf_email__'));

  // login sends token to onboard (audit #1)
  const login = read('login.html');
  check('login: onboard called with Bearer token', /Authorization: `Bearer \$\{accessToken\}`/.test(login) && /await syncUser\(data\.session\.access_token/.test(login));
  check('login: check-your-email state when no session (audit #55)', /check your inbox and confirm your email/.test(login));

  // legal pages exist and are linked (audit #54/#69)
  check('terms.html + privacy.html exist', fs.existsSync(path + '/terms.html') && fs.existsSync(path + '/privacy.html'));
  check('index footer links legal pages', /href="\/privacy\.html"/.test(read('index.html')) && /href="\/terms\.html"/.test(read('index.html')));

  // hygiene (audit #13/#67)
  check('.gitignore exists', fs.existsSync(path + '/.gitignore'));
  check('.vercelignore excludes schema.ts/docs', read('.vercelignore').includes('schema.ts'));
  check('stale root copies deleted', !fs.existsSync(path + '/settings.js') && !fs.existsSync(path + '/dashboard-data.js'));

  // prompt guardrails (audit #12)
  check('AI prompts have guardrails (no discounts/links)', read('server/recovery/send-note.js').includes('never offer discounts') && read('server/recovery/send-sms.js').includes('never offer discounts'));

  // schema parity (audit #40/#42)
  const schema = read('schema.ts');
  check('schema.ts: users.supabase_user_id + unique, slug nullable', /supabaseUserId: text\("supabase_user_id"\)/.test(schema) && /users_supabase_user_id_idx/.test(schema) && /slug: text\("slug"\), \/\/ audit #40/.test(schema));
  check('schema.ts: idempotency_key unique + hot indexes', /recovery_attempts_idempotency_key_idx/.test(schema) && /recovery_cases_org_status_idx/.test(schema) && /activity_feed_org_created_idx/.test(schema));
}

// ═══════════════════════════════════════════════════════════════════════════════
(async () => {
  try {
    await testRouter();
    await testOnboardSecurity();
    await testRoleGates();
    await testSettings();
    await testWebhookMoneyPath();
    await testRetryGuards();
    await testKeysAndPublic();
    await testExports();
    testSources();
  } catch (e) {
    failures++;
    console.error('UNCAUGHT TEST ERROR:', e);
  } finally {
    global.fetch = realFetch;
  }
  console.log('\n' + (failures === 0 ? `ALL ${passes} TESTS PASSED ✔` : `${failures} FAILURE(S) ✘ (${passes} passed)`));
  process.exit(failures === 0 ? 0 : 1);
})();
