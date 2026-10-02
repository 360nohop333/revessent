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

  // 2nd-opinion #21: SSRF — private/internal alert webhook destinations rejected
  for (const bad of ['http://127.0.0.1:8080/hook', 'http://10.0.0.5/hook', 'http://192.168.1.4/hook', 'http://172.16.9.9/hook', 'http://169.254.169.254/latest/meta-data', 'http://localhost/hook', 'ftp://hooks.slack.com/x']) {
    res = await call(settings, makeReq('POST', { headers: AUTH, body: JSON.stringify({ organizationId: 'org-1', brandName: 'B', senderName: 'S', senderEmail: 's@own-domain.com', tone: 'professional', smsEnabled: false, alertWebhookUrl: bad }) }));
    if (res.statusCode !== 400) { check('settings POST: SSRF destination ' + bad + ' → 400', false, String(res.statusCode)); break; }
  }
  check('settings POST: private/internal alert webhook URLs → 400 (SSRF)', true);
  res = await call(settings, makeReq('POST', { headers: AUTH, body: JSON.stringify({ organizationId: 'org-1', brandName: 'B', senderName: 'S', senderEmail: 's@own-domain.com', tone: 'professional', smsEnabled: false, alertWebhookUrl: 'https://hooks.slack.com/services/ok' }) }));
  check('settings POST: public https webhook accepted', res.statusCode === 200, JSON.stringify(res.body));
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
  // batch-2 captures
  let caseInserts = []; // recovery_cases insert params (UPI scheduling assertions)
  let memberInserts = []; // stripe_members insert params (phone-name assertion)
  let subUpserts = []; // stripe_subscriptions upsert params (audit #23)
  let memberNotFound = false; // when true, member lookups return nothing → insert path

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
      [/from stripe_members/, () => ({ rows: memberNotFound ? [] : [MEMBER_ROW] })],
      [/insert into stripe_members/, ({ params }) => { memberInserts.push(params); return { rows: [{ ...MEMBER_ROW, id: 'member-new' }] }; }],
      [/update stripe_members/, () => ({ rows: [MEMBER_ROW] })],
      [/from stripe_subscriptions/, () => ({ rows: [] })],
      [/insert into stripe_subscriptions/, ({ params }) => { subUpserts.push(params); return { rows: [] }; }],
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
        caseInserts.push(params);
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

  // 10. audit #26: UPI per-transaction-limit failures are payday-cycle
  // 'insufficient_funds', NOT a dead case — first retry lands at +3 days.
  caseInserts = []; subUpserts = [];
  res = await post('payment.failed', { id: 'pay_upi1', amount: 9000, currency: 'INR', status: 'failed', error_description: 'UPI per transaction limit of INR 5000.00 exceeded', email: 'a@b.com', subscription_id: 'sub_upi1' });
  const upiLimitCase = caseInserts.find((p) => p[4] === 'pay_upi1');
  check('webhook: UPI per-txn limit → insufficient_funds, +3d retry, detected', res.statusCode === 200 && upiLimitCase && upiLimitCase[6] === 'insufficient_funds' && upiLimitCase[9] === 3 && upiLimitCase[5] === 'detected', JSON.stringify(upiLimitCase && [upiLimitCase[5], upiLimitCase[6], upiLimitCase[9]]));

  // 11. audit #26: UPI mandate/NACH failures need the customer to fix the
  // mandate — never auto-retried: no next_retry_at, parked for a human.
  caseInserts = [];
  res = await post('payment.failed', { id: 'pay_upi2', amount: 9000, currency: 'INR', status: 'failed', error_description: 'UPI mandate revoked by customer (NACH debit rejected)', email: 'a@b.com', subscription_id: 'sub_upi2' });
  const mandateCase = caseInserts.find((p) => p[4] === 'pay_upi2');
  check('webhook: UPI mandate/NACH → upi_mandate_issue, no auto retry', res.statusCode === 200 && mandateCase && mandateCase[6] === 'upi_mandate_issue' && mandateCase[9] == null && mandateCase[5] === 'awaiting_approval', JSON.stringify(mandateCase && [mandateCase[5], mandateCase[6], mandateCase[9]]));
  const mandateSub = subUpserts.find((p) => p[3] === 'sub_upi2');
  check('webhook: failed payment upserts subscription → past_due (audit #23)', Boolean(mandateSub) && mandateSub[4] === 'past_due', JSON.stringify(mandateSub && [mandateSub[3], mandateSub[4]]));

  // 12. audit #39: a phone number in Razorpay's name field must never be
  // stored as a person's name.
  memberNotFound = true; memberInserts = [];
  res = await post('payment.failed', { id: 'pay_phone', amount: 9000, currency: 'INR', status: 'failed', error_code: 'card_declined_by_bank', email: 'phone@b.com', contact: '+91 98765 43210', name: '+91 98765 43210' });
  const phoneInsert = memberInserts[0];
  check('webhook: phone-like name blanked on member insert', res.statusCode === 200 && phoneInsert && phoneInsert[4] === '' && phoneInsert[3] === 'phone@b.com', JSON.stringify(phoneInsert));
  memberNotFound = false;

  // 13. audit #23: a captured payment (recovery) upserts the subscription
  // back to 'active'.
  subUpserts = [];
  clientOpenCase = { id: 'case-open', member_id: 'member-1', amount_cents: 25000, currency: 'INR' };
  res = await post('payment.captured', { id: 'pay_capsub', amount: 25000, currency: 'INR', status: 'captured', email: 'a@b.com', subscription_id: 'sub_good' });
  const capSub = subUpserts.find((p) => p[3] === 'sub_good');
  check('webhook: captured payment upserts subscription → active (audit #23)', res.statusCode === 200 && Boolean(capSub) && capSub[4] === 'active', JSON.stringify(capSub && [capSub[3], capSub[4]]));
  clientOpenCase = null;
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

  // batch-2 frontend + docs parity
  check('reset-password.html exists + login redirects to it (audit #56)', fs.existsSync(path + '/reset-password.html') && read('login.html').includes('reset-password.html'));
  check('index lead forms really POST /api/leads (audit #47)', (read('index.html').match(/\/api\/leads/g) || []).length >= 3);
  check('dashboard: currency-aware money + no hard-coded $ KPIs (audit #51)', read('dashboard.html').includes('DASH_CURRENCY') && !read('dashboard.html').includes('data-prefix="$"'));
  check('dashboard: connect card routes to Settings, no fake success (audit #48)', /settings\.html/.test(read('dashboard.html')) && !read('dashboard.html').includes('Razorpay connected — Revessent is ready'));
  check('.env.example matches the real stack (audit #65)', !read('.env.example').includes('BETTER_AUTH') && !read('.env.example').includes('STRIPE_SECRET_KEY') && read('.env.example').includes('CRON_SECRET'));
  check('schema.ts: batch-2 tables (leads, suppression_list, audit_log)', /export const leads = pgTable\("leads"/.test(schema) && /pgTable\("suppression_list"/.test(schema) && /pgTable\("audit_log"/.test(schema));

  // batch-3 parity
  check('robots.txt + sitemap.xml exist (audit #63)', fs.existsSync(path + '/robots.txt') && fs.existsSync(path + '/sitemap.xml'));
  check('CI workflow runs the suite (audit #67)', fs.existsSync(path + '/.github/workflows/ci.yml') && read('.github/workflows/ci.yml').includes('suite.test.js'));
  check('onboarding.html orphan deleted (audit #58)', !fs.existsSync(path + '/onboarding.html'));
  check('migrations tooling: 3 SQL files + runner + npm script (audit #41)', fs.existsSync(path + '/scripts/migrate.js') && fs.readdirSync(path + '/migrations').filter((f) => f.endsWith('.sql')).length === 5 && read('package.json').includes('\"migrate\"'));
  check('index: no read-only key claims, no refund guarantee, ₹ pricing (audit #6/#49/#50/#51)', !/read-only/i.test(read('index.html')) && !/we refund you/i.test(read('index.html')) && !/refund the full term/i.test(read('index.html')) && /class="cur">₹</.test(read('index.html')));
  check('connect: full Razorpay event set registered (audit #24)', /subscription\.cancelled/.test(read('server/razorpay/connect.js')) && /refund\.processed/.test(read('server/razorpay/connect.js')));
  check('send-note: Resend emails tagged with org (audit #37)', /tags: \['org:' \+ organizationId/.test(read('server/recovery/send-note.js')));
  check('settings: audit log + account sections wired (audit #16/#60)', /id="auditList"/.test(read('settings.html')) && /id="accountCard"/.test(read('settings.html')) && /changePasswordBtn/.test(read('settings.html')) && /deleteWorkspaceBtn/.test(read('settings.html')));
  check('privacy: 30-day webhook payload retention stated (audit #14)', /30 days/.test(read('privacy.html')));
  const authFiles = ['settings', 'keys', 'members', 'dashboard-data', 'digests', 'organization', 'referrals', 'recovery/case', 'recovery/retry', 'recovery/send-note', 'recovery/send-sms', 'razorpay/connect', 'razorpay/backfill', 'alerts/send', 'alerts/test', 'export/cases', 'export/members', 'audit'].map((n) => 'server/' + n + '.js');
  check('shared auth: 18 handlers import _lib/supabase-auth (audit #66)', authFiles.every((f) => read(f).includes("_lib/supabase-auth")), authFiles.filter((f) => !read(f).includes('_lib/supabase-auth')).join(','));
  check('members: pagination params in the endpoint (audit #64)', /limit \\\$2 offset \\\$3/.test(read('server/members.js')) || /offset/.test(read('server/members.js')));
  check('pages load /api/config.js with fallback intact (audit #66)', ['login.html', 'dashboard.html', 'members.html', 'settings.html', 'weekly-digest.html', 'case-detail.html', 'reset-password.html'].every((f) => read(f).includes('/api/config.js')));
  // ── batch-4 source checks (2nd-opinion audit) ──
  const mnavOk = ['members.html', 'weekly-digest.html', 'case-detail.html'].every((p) => {
    const h = read(p);
    return h.includes('id="mnavBtn"') && h.includes('.mnav{display:none}') && h.includes('sb.classList.toggle');
  });
  check('mobile nav: hamburger reachable sidebar on members/digest/case pages (2nd-opinion #10)', mnavOk);
  check('index: demo workspace uses ₹ like the product (2nd-opinion #26)', !read('index.html').includes('data-prefix="$"') && read('index.html').includes('data-prefix="₹"'));
  const mh = read('members.html');
  check('members: debounced server-side search + honest column label (2nd-opinion #11/#12)', mh.includes("search='+encodeURIComponent(SEARCH)") && mh.includes('searchTimer') && mh.includes('Subscription value'));
  check('members: zero-decimal currency support (2nd-opinion #39)', mh.includes('ZERO_DECIMAL_CURRENCIES'));
  check('digest: narrative rendered via textContent, not innerHTML (2nd-opinion #13)', !/digestList'\)\.innerHTML/.test(read('weekly-digest.html')));
  check('send-note: sent notes are a 409, not a silent resend (2nd-opinion #5)', read('server/recovery/send-note.js').includes("error.statusCode = 409"));
  const routerH = read('api/[...route].js');
  check('router: bulk-approve + replay + sms-inbound wired (2nd-opinion #34/#35)', routerH.includes('recovery/bulk-approve') && routerH.includes('webhooks/replay') && routerH.includes('webhooks/sms-inbound'));
  const exemptBlock = routerH.slice(routerH.indexOf('const exempt'), routerH.indexOf('const exempt') + 400);
  check('router: sms-inbound rate-limit exempt (Twilio retries)', exemptBlock.includes('webhooks/sms-inbound'));
  check('webhook: outer transaction failure → 500 (2nd-opinion #3)', read('server/webhooks/razorpay.js').includes('Could not record the webhook event') || /sendJson\(res, 500/.test(read('server/webhooks/razorpay.js')));
  check('razorpay: refunds reverse attribution, capped (2nd-opinion #4)', /least\(amount_cents/.test(read('server/webhooks/razorpay.js')));
  const rj = read('server/webhooks/razorpay.js');
  check('razorpay: payment-link recovery reconciles subscription (2nd-opinion #2)', rj.includes('order by created_at desc') && rj.includes("'active'"));
  check('recovery: Option-B contract documented (2nd-opinion #2)', rj.includes('Option B') || rj.includes('payment link collects'));
  check('settings: private/loopback alert URLs rejected (2nd-opinion #21)', read('server/settings.js').includes('isPublicHttpUrl'));
  check('deletion: audit trail survives org cascade (2nd-opinion #23)', read('server/organization.js').includes('deletion_log') && /insert into deletion_log[\s\S]*before/i.test(read('server/organization.js')));
  check('migrations: 5 files incl. 0000 bootstrap + 0004 fixes', (() => { const files = fs.readdirSync(path + '/migrations').filter((f) => f.endsWith('.sql')).sort(); return files.length === 5 && files[0] === '0000_initial_schema.sql' && files[4] === '0004_batch4_fixes.sql'; })());
  check('changelog: seeds in 0004 so the public page is not empty (2nd-opinion #15)', read('migrations/0004_batch4_fixes.sql').includes('changelog_entries'));
  check('lockfile committed + CI installs with npm ci (2nd-opinion #24)', fs.existsSync(path + '/package-lock.json') && read('.github/workflows/ci.yml').includes('npm ci'));
  check('docs: Twilio env vars documented (2nd-opinion #17)', read('README.md').includes('TWILIO_ACCOUNT_SID') && read('.env.example').includes('TWILIO_AUTH_TOKEN'));
  check('supabase-auth: loud prod warning on default fallback (2nd-opinion #20)', read('server/_lib/supabase-auth.js').includes('VERCEL_ENV') && read('server/_lib/supabase-auth.js').includes('HARD-CODED'));
  check('digest copy: auto-generated, not "added later" (2nd-opinion #14)', !read('weekly-digest.html').toLowerCase().includes('added later'));

  check('dashboard: 401 → one refresh + retry before redirect (audit #59)', /refreshSession/.test(read('dashboard.html')) && /_retried/.test(read('dashboard.html')));
}

// ═══════════════════════════════════════════════════════════════════════════════
async function testBatch2() {
  console.log('\n── batch-2: leads, unsubscribe, health, rate limit, cron gates, dashboard ──');

  const savedEnv = {};
  for (const key of ['ENCRYPTION_KEY', 'CRON_SECRET', 'GEMINI_API_KEY', 'RESEND_API_KEY', 'RESEND_FROM_EMAIL']) {
    savedEnv[key] = process.env[key];
  }
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key';
  process.env.CRON_SECRET = 'cron-secret-test';
  process.env.GEMINI_API_KEY = 'gem-test';
  process.env.RESEND_API_KEY = 're-test';
  process.env.RESEND_FROM_EMAIL = 'hello@revessent.com';

  // fetch mock extended for Gemini drafting + Resend sends (suppression/footer tests)
  let RESEND_CALLS = [];
  const prevFetch = global.fetch;
  global.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return { ok: true, status: 200, json: async () => SUPABASE_USER };
    if (u.includes('generativelanguage.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Hi Priya, your payment did not go through. Please update your payment method when you get a moment — Team Acme.' }] } }] }) };
    }
    if (u.includes('api.resend.com/emails')) {
      RESEND_CALLS.push({ url: u, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ id: 're-123' }) };
    }
    return prevFetch(url, options);
  };

  // request helper for ROUTER calls (url must be the real /api/<route> path)
  function apiReq(method, route, { headers = {}, query = '', body } = {}) {
    const parsed = {};
    new URLSearchParams(query.replace(/^\?/, '')).forEach((v, k) => { parsed[k] = v; });
    return {
      method, url: '/api/' + route + query, query: parsed, headers,
      [Symbol.asyncIterator]: async function* () { if (body != null) yield Buffer.from(body); },
    };
  }

  try {
    // ── leads (audit #47) ──
    const leads = require(path + '/server/leads.js');
    let leadInserts = [];
    CURRENT_CLIENT = fakeClient([
      [/insert into leads/, ({ params }) => { leadInserts.push(params); return { rows: [] }; }],
    ]);
    let res = await call(leads, makeReq('POST', { body: JSON.stringify({ email: '  Pilot@Example.COM ', source: 'hero-form' }) }));
    check('leads: POST → 200, email trimmed + lowercased before insert', res.statusCode === 200 && res.body.success === true && leadInserts[0][1] === 'pilot@example.com' && leadInserts[0][2] === 'hero-form', JSON.stringify(leadInserts));
    res = await call(leads, makeReq('POST', { body: JSON.stringify({ email: 'not-an-email' }) }));
    check('leads: invalid email → 400, nothing inserted', res.statusCode === 400 && leadInserts.length === 1, JSON.stringify(res.body));
    res = await call(leads, makeReq('GET', {}));
    check('leads: GET → 405', res.statusCode === 405, String(res.statusCode));

    // ── unsubscribe tokens (audit #35) ──
    const { createUnsubscribeToken, verifyUnsubscribeToken } = require(path + '/server/_lib/unsubscribe-token.js');
    const token = createUnsubscribeToken('org-9', 'member-9', 'User@Example.com');
    const payload = verifyUnsubscribeToken(token);
    check('unsub token: create → verify round-trip', payload && payload.organizationId === 'org-9' && payload.memberId === 'member-9' && payload.email === 'User@Example.com', JSON.stringify(payload));
    check('unsub token: tampered signature rejected', verifyUnsubscribeToken(token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')) === null);
    check('unsub token: garbage/missing parts rejected', verifyUnsubscribeToken('hello') === null && verifyUnsubscribeToken('') === null && verifyUnsubscribeToken('a.b') === null);

    // ── unsubscribe endpoint (audit #35/#37) ──
    const unsub = require(path + '/server/unsubscribe.js');
    let suppressionInserts = [];
    CURRENT_CLIENT = fakeClient([
      [/insert into suppression_list/, ({ sql, params }) => { suppressionInserts.push({ sql, params }); return { rows: [] }; }],
    ]);
    res = await call(unsub, makeReq('GET', { query: '?token=' + encodeURIComponent(token) }));
    check('unsubscribe: valid token → 200 page + suppression upsert (idempotent)', res.statusCode === 200 && /unsubscribed/i.test(String(res.raw)) && suppressionInserts.length === 1 && suppressionInserts[0].params[1] === 'org-9' && suppressionInserts[0].params[3] === 'user@example.com' && /on conflict \(organization_id, lower\(email\)\)/.test(suppressionInserts[0].sql), JSON.stringify(suppressionInserts.map((s) => s.params)));
    res = await call(unsub, makeReq('GET', { query: '' }));
    check('unsubscribe: missing/invalid token → 400', res.statusCode === 400, String(res.statusCode));

    // ── health (audit #67) ──
    const health = require(path + '/server/health.js');
    res = await call(health, makeReq('GET', {}));
    check('health: GET → 200 {ok:true}', res.statusCode === 200 && res.body && res.body.ok === true, JSON.stringify(res.body));

    // ── rate limiting (audit #10, partial — in-memory) ──
    const router = require(path + '/api/[...route].js');
    const RL_IP = '203.0.113.9';
    const rlStatuses = [];
    for (let i = 0; i < 31; i++) {
      const r = await call(router, apiReq('POST', 'leads', { headers: { 'x-forwarded-for': RL_IP }, body: JSON.stringify({ email: 'bad' }) }));
      rlStatuses.push(r.statusCode);
    }
    check('rate limit: first 30 writes reach the handler (400 = invalid email)', rlStatuses.slice(0, 30).every((s) => s === 400), rlStatuses.join(','));
    check('rate limit: 31st write inside the window → 429', rlStatuses[30] === 429, String(rlStatuses[30]));

    let allOk = true;
    for (let i = 0; i < 40; i++) {
      const r = await call(router, apiReq('GET', 'health', { headers: { 'x-forwarded-for': RL_IP } }));
      if (r.statusCode !== 200) allOk = false;
    }
    check('rate limit: reads are never limited (40 GETs, all 200)', allOk);

    CURRENT_CLIENT = fakeClient([
      TXN, SAVEPOINT,
      [/from stripe_connections/, () => ({ rows: [{ organization_id: 'org-1', webhook_secret: 'whsec_t' }] })],
    ]);
    let whStatuses = [];
    for (let i = 0; i < 35; i++) {
      const r = await call(router, apiReq('POST', 'webhooks/razorpay', { headers: { 'x-forwarded-for': RL_IP, 'x-razorpay-signature': 'deadbeef' }, query: '?org=org-1', body: '{}' }));
      whStatuses.push(r.statusCode);
    }
    check('rate limit: webhook + cron routes are exempt (35 posts, no 429)', whStatuses.every((s) => s === 400), whStatuses.join(','));

    // ── send-note: suppression + unsubscribe footer (audit #35/#37) ──
    const sendNote = require(path + '/server/recovery/send-note.js');
    const CASE_CONTEXT = {
      id: 'case-s1', organization_id: 'org-1', member_id: 'member-1', status: 'detected',
      member_name: 'Priya Sharma', member_email: 'priya@x.com', organization_name: 'Acme',
      amount_cents: 50000, currency: 'INR', decline_code: 'insufficient_funds',
    };
    let suppressedRows = [{}];
    let auditInserts = [];
    function sendNoteClient() {
      return fakeClient([
        TXN, SAVEPOINT, AUTH_BY_SBUID,
        [/from recovery_cases rc\s+left join stripe_members/, () => ({ rows: [CASE_CONTEXT] })],
        [/from voice_profiles/, () => ({ rows: [{ brand_name: 'Acme', sender_name: 'Team Acme', sender_email: 'hello@acme.com', tone_description: 'Friendly' }] })],
        [/insert into recovery_notes/, () => ({ rows: [] })],
        [/update recovery_notes/, () => ({ rows: [] })],
        [/from suppression_list/, () => ({ rows: suppressedRows })],
        [/update recovery_cases/, () => ({ rows: [] })],
        [/insert into activity_feed/, () => ({ rows: [] })],
        [/insert into audit_log/, ({ params }) => { auditInserts.push(params); return { rows: [] }; }],
      ]);
    }
    CURRENT_CLIENT = sendNoteClient(); RESEND_CALLS = []; auditInserts = [];
    res = await call(sendNote, makeReq('POST', { headers: AUTH, body: JSON.stringify({ caseId: 'case-s1', autoSend: true }) }));
    check('send-note: suppressed recipient → 409, nothing emailed', res.statusCode === 409 && RESEND_CALLS.length === 0, JSON.stringify(res.body));

    suppressedRows = [];
    CURRENT_CLIENT = sendNoteClient(); RESEND_CALLS = []; auditInserts = [];
    res = await call(sendNote, makeReq('POST', { headers: AUTH, body: JSON.stringify({ caseId: 'case-s1', autoSend: true }) }));
    const sentBody = RESEND_CALLS[0] && RESEND_CALLS[0].body;
    check('send-note: send carries unsubscribe footer + plain-text part + reply-to', res.statusCode === 200 && RESEND_CALLS.length === 1
      && /\/api\/unsubscribe\?token=/.test(String(sentBody.html))
      && /Unsubscribe:/.test(String(sentBody.text))
      && sentBody.reply_to === 'hello@acme.com'
      && sentBody.to[0] === 'priya@x.com', JSON.stringify(sentBody && { html: String(sentBody.html).slice(-120), reply_to: sentBody.reply_to }));
    check('send-note: autoSend stamps approval + writes audit_log (audit #16/#38)', res.statusCode === 200 && auditInserts.length === 1 && auditInserts[0][3] === 'note.sent', JSON.stringify(auditInserts.map((a) => a[3])));

    // ── cron: auth + trust-level gate + stale sweep (audit #32/#38) ──
    const cron = require(path + '/server/cron/process-recovery-queue.js');
    CURRENT_CLIENT = fakeClient([TXN]);
    res = await call(cron, makeReq('GET', {}));
    check('cron: missing secret → 401', res.statusCode === 401, String(res.statusCode));

    const DUE_CASE = (extra) => ({
      id: 'case-due', organization_id: 'org-1', member_id: 'member-1', status: 'detected',
      amount_cents: 50000, currency: 'INR', decline_code: 'stolen_card',
      retry_count: 0, max_retries: 3, next_retry_at: '2026-09-01T00:00:00Z',
      org_trust_level: 'approval_required', ...extra,
    });
    let cronRuns = { staleSweep: 0, awaitingUpdates: [], activities: [], caseCtx: null };
    function cronClient(dueRows) {
      return fakeClient([
        TXN, SAVEPOINT,
        [/set status = 'failed',[\s\S]*'stale'/, () => { cronRuns.staleSweep += 1; return { rows: [] }; }],
        [/from recovery_cases rc\s+join organizations/, () => ({ rows: dueRows })],
        [/set next_retry_at = null/, () => ({ rows: [] })],
        [/set status = 'awaiting_approval'/, ({ params }) => { cronRuns.awaitingUpdates.push(params); return { rows: [] }; }],
        [/from recovery_cases rc\s+left join stripe_members/, () => ({ rows: cronRuns.caseCtx ? [cronRuns.caseCtx] : [] })],
        [/from voice_profiles/, () => ({ rows: [{ brand_name: 'Acme', sender_name: 'Team Acme', sender_email: 'hello@acme.com', tone_description: 'Friendly' }] })],
        [/insert into recovery_notes/, () => ({ rows: [] })],
        [/from suppression_list/, () => ({ rows: [] })],
        [/update recovery_notes/, () => ({ rows: [] })],
        [/set status = 'note_sent'/, () => ({ rows: [] })],
        [/insert into activity_feed/, ({ params }) => { cronRuns.activities.push(params); return { rows: [] }; }],
      ]);
    }

    CURRENT_CLIENT = cronClient([DUE_CASE({ id: 'case-appr' })]); RESEND_CALLS = []; cronRuns = { staleSweep: 0, awaitingUpdates: [], activities: [], caseCtx: null };
    res = await call(cron, makeReq('GET', { headers: { authorization: 'Bearer cron-secret-test' } }));
    check('cron: approval_required org → case parked, NO customer email', res.statusCode === 200 && res.body.processed === 1 && res.body.emailsSent === 0 && RESEND_CALLS.length === 0
      && cronRuns.awaitingUpdates.length === 1 && cronRuns.awaitingUpdates[0][0] === 'case-appr'
      && cronRuns.activities.some((a) => a[2] === 'awaiting_approval'), JSON.stringify({ body: res.body, awaiting: cronRuns.awaitingUpdates, acts: cronRuns.activities.map((a) => a[2]) }));
    check('cron: stale pending attempts swept (audit #32)', cronRuns.staleSweep === 1, 'sweeps=' + cronRuns.staleSweep);

    CURRENT_CLIENT = cronClient([DUE_CASE({ id: 'case-trust', org_trust_level: 'trusted' })]); RESEND_CALLS = []; cronRuns = { staleSweep: 0, awaitingUpdates: [], activities: [], caseCtx: { ...CASE_CONTEXT, id: 'case-trust' } };
    res = await call(cron, makeReq('GET', { headers: { authorization: 'Bearer cron-secret-test' } }));
    check('cron: trusted org → recovery email sent with unsubscribe footer', res.statusCode === 200 && res.body.emailsSent === 1 && RESEND_CALLS.length === 1
      && /\/api\/unsubscribe\?token=/.test(String(RESEND_CALLS[0].body.html)), JSON.stringify(res.body));

    // ── dashboard-data: currency + pilot window (audit #49/#51) ──
    const dash = require(path + '/server/dashboard-data.js');
    function dashClient({ pilotRow, currencyRow }) {
      return fakeClient([
        AUTH_BY_SBUID,
        [/with weeks as/, () => ({ rows: [] })],
        [/from recovery_attributions/, () => ({ rows: [{ current_cents: 100000, prior_cents: 50000 }] })],
        [/as open_case_count/, () => ({ rows: [{ amount_cents: 200000, open_case_count: 2 }] })],
        [/filter \(where status = 'recovered'\)/, () => ({ rows: [{ recovered_count: 3, closed_count: 4 }] })],
        [/select status, count\(\*\)::int as count/, () => ({ rows: [] })],
        [/select decline_code,/, () => ({ rows: [] })],
        [/from recovery_cases rc\s+join stripe_members/, () => ({ rows: [] })],
        [/from activity_feed/, () => ({ rows: [] })],
        [/select pilot_started_at, pilot_ends_at from organizations/, () => ({ rows: pilotRow ? [pilotRow] : [] })],
        [/select currency from recovery_cases/, () => ({ rows: currencyRow ? [currencyRow] : [] })],
      ]);
    }
    CURRENT_CLIENT = dashClient({ pilotRow: { pilot_started_at: '2026-09-20T00:00:00.000Z', pilot_ends_at: '2026-10-04T00:00:00.000Z' }, currencyRow: { currency: 'INR' } });
    res = await call(dash, makeReq('GET', { headers: AUTH, query: '?range=30d' }));
    check('dashboard: response carries workspace currency + pilot window', res.statusCode === 200 && res.body.currency === 'INR'
      && res.body.pilot && res.body.pilot.startedAt === '2026-09-20T00:00:00.000Z' && res.body.pilot.endsAt === '2026-10-04T00:00:00.000Z'
      && res.body.revenueRecovered && res.body.revenueRecovered.amountCents === 100000
      && res.body.recoveryRate && res.body.recoveryRate.percent === 75
      , JSON.stringify({ currency: res.body.currency, pilot: res.body.pilot }));

    CURRENT_CLIENT = dashClient({ pilotRow: null, currencyRow: null });
    res = await call(dash, makeReq('GET', { headers: AUTH, query: '?range=7d' }));
    check('dashboard: currency defaults to INR, pilot nulls when unset', res.statusCode === 200 && res.body.currency === 'INR' && res.body.pilot && res.body.pilot.startedAt == null && res.body.pilot.endsAt == null, JSON.stringify({ currency: res.body.currency, pilot: res.body.pilot }));
  } finally {
    global.fetch = prevFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
async function testBatch3() {
  console.log('\n── batch-3: audit viewer, resend webhooks, org delete, pagination, events, crypto, JWT, upstash ──');

  const savedEnv = {};
  for (const key of ['ENCRYPTION_KEY', 'ENCRYPTION_KEY_OLD', 'RESEND_WEBHOOK_SECRET', 'SUPABASE_JWT_SECRET', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'GEMINI_API_KEY', 'RESEND_API_KEY', 'CRON_SECRET']) {
    savedEnv[key] = process.env[key];
  }
  process.env.ENCRYPTION_KEY = 'aa'.repeat(32);
  process.env.GEMINI_API_KEY = 'gem-test';
  process.env.RESEND_API_KEY = 're-test';

  let RESEND_CALLS = [];
  let UPSTASH_CALLS = [];
  let USERINFO_CALLS = 0;
  const prevFetch = global.fetch;
  global.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) { USERINFO_CALLS += 1; return prevFetch(url, options); }
    if (u.includes('api.resend.com/emails')) { RESEND_CALLS.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ id: 're-1' }) }; }
    if (u.includes('upstash')) { UPSTASH_CALLS.push({ url: u, body: options && options.body }); return { ok: true, status: 200, json: async () => UPSTASH_RESPONSE() }; }
    return prevFetch(url, options);
  };
  let UPSTASH_RESPONSE = () => [{ result: 1 }, { result: 1 }];
  process.env.CRON_SECRET = 'cron-secret-test'; // batch-3 cron tests re-auth

  function apiReq(method, route, { headers = {}, query = '', body } = {}) {
    const parsed = {};
    new URLSearchParams(query.replace(/^\?/, '')).forEach((v, k) => { parsed[k] = v; });
    return { method, url: '/api/' + route + query, query: parsed, headers, [Symbol.asyncIterator]: async function* () { if (body != null) yield Buffer.from(body); } };
  }

  try {
    // ── secret box (audit #7): rotation + legacy plaintext ──
    const box = require(path + '/server/_lib/secret-box.js');
    const enc = box.encryptToString('whsec_abc');
    check('secret-box: enc:v1 roundtrip + legacy passthrough', enc.startsWith('enc:v1:') && box.decryptFromString(enc) === 'whsec_abc' && box.decryptFromString('whsec_plain') === 'whsec_plain');
    process.env.ENCRYPTION_KEY = 'bb'.repeat(32);
    process.env.ENCRYPTION_KEY_OLD = 'aa'.repeat(32);
    check('secret-box: ENCRYPTION_KEY_OLD fallback works', box.decryptFromString(enc) === 'whsec_abc');
    process.env.ENCRYPTION_KEY_OLD = '';
    let rotationThrew = false;
    try { box.decryptFromString(enc); } catch (_) { rotationThrew = true; }
    check('secret-box: without old key rotation fails loudly (400)', rotationThrew);
    process.env.ENCRYPTION_KEY = 'aa'.repeat(32);
    const encCols = box.encryptColumns('rzp_secret');
    const roundtrip = (() => { try { return box.decryptColumns(encCols.encrypted, encCols.iv, encCols.tag) === 'rzp_secret'; } catch (_) { return false; } })();
    check('secret-box: column-triplet encrypt/decrypt', roundtrip);

    // ── /api/audit (audit #16): owner sees rows, member 403 ──
    const auditMod = require(path + '/server/audit.js');
    let auditSelects = [];
    CURRENT_CLIENT = fakeClient([
      AUTH_BY_SBUID,
      [/from audit_log[\s\S]*left join users/, ({ sql }) => { auditSelects.push(sql); return { rows: [{ id: 'a1', action: 'api_key.created', detail: { keyPrefix: 'rvsk_x' }, created_at: '2026-10-01T10:00:00Z', user_email: 'owner@test.com' }] }; }],
    ]);
    let res = await call(auditMod, makeReq('GET', { headers: AUTH, query: '?limit=50' }));
    check('audit: owner → 200 with rows', res.statusCode === 200 && res.body.audit.length === 1 && res.body.audit[0].action === 'api_key.created', JSON.stringify(res.body));
    const memberRow = { ...USERS_ROW, role: 'member' };
    CURRENT_CLIENT = fakeClient([[/from users\s+where supabase_user_id/, () => ({ rows: [memberRow] })]]);
    res = await call(auditMod, makeReq('GET', { headers: AUTH }));
    check('audit: member → 403', res.statusCode === 403, String(res.statusCode));

    // ── /api/config.js (audit #66): env-sourced JS snippet ──
    const configMod = require(path + '/server/config.js');
    process.env.SUPABASE_URL = 'https://config-test.supabase.co';
    res = await call(configMod, makeReq('GET', {}));
    check('config.js: JS body with env URL + JS content type', res.statusCode === 200 && /window.REVESSENT_SUPABASE_CONFIG/.test(String(res.raw)) && /config-test\.supabase\.co/.test(String(res.raw)) && String(res.headers['Content-Type']).includes('javascript'), String(res.raw));
    delete process.env.SUPABASE_URL;

    // ── DELETE /api/organization (audit #60) ──
    const orgMod = require(path + '/server/organization.js');
    let orgDeletes = [];
    let orgAudits = [];
    CURRENT_CLIENT = fakeClient([
      TXN, AUTH_BY_SBUID,
      [/select name from organizations/, () => ({ rows: [{ name: 'Acme' }] })],
      [/insert into deletion_log/, ({ params }) => { orgDeletes.deletionLog = params; return { rows: [] }; }],
      [/insert into audit_log/, ({ params }) => { orgAudits.push(params); return { rows: [] }; }],
      [/delete from organizations/, ({ params }) => { orgDeletes.push(params); return { rows: [{ id: params[0] }] }; }],
    ]);
    res = await call(orgMod, makeReq('DELETE', { headers: AUTH, body: JSON.stringify({ confirm: 'nope' }) }));
    check('org delete: wrong confirm → 400, nothing deleted', res.statusCode === 400 && orgDeletes.length === 0, JSON.stringify(res.body));
    res = await call(orgMod, makeReq('DELETE', { headers: AUTH, body: JSON.stringify({ confirm: 'DELETE' }) }));
    check('org delete: owner + DELETE → deletion log + cascade + audit row', res.statusCode === 200 && res.body.deleted === true && orgDeletes.length === 1 && orgDeletes[0][0] === 'org-1' && orgAudits.length === 1 && orgAudits[0][3] === 'organization.deleted' && orgDeletes.deletionLog && orgDeletes.deletionLog[1] === 'org-1' && orgDeletes.deletionLog[2] === 'Acme', JSON.stringify(res.body));
    CURRENT_CLIENT = fakeClient([[/from users\s+where supabase_user_id/, () => ({ rows: [memberRow] })]]);
    res = await call(orgMod, makeReq('DELETE', { headers: AUTH, body: JSON.stringify({ confirm: 'DELETE' }) }));
    check('org delete: member → 403', res.statusCode === 403, String(res.statusCode));

    // ── members pagination (audit #64) ──
    const membersMod = require(path + '/server/members.js');
    let memberQueries = [];
    CURRENT_CLIENT = fakeClient([
      AUTH_BY_SBUID,
      [/limit \$2 offset \$3/, ({ sql, params }) => { memberQueries.push({ sql, params }); return { rows: [{ id: 'm1', name: 'A', email: 'a@b.com' }] }; }],
      [/select count\(\*\)::int as total from stripe_members/, ({ sql }) => { memberQueries.push({ sql }); return { rows: [{ total: 250 }] }; }],
      [/select member_id, id as case_id/, () => ({ rows: [] })],
    ]);
    res = await call(membersMod, makeReq('GET', { headers: AUTH, query: '?limit=100&offset=100' }));
    check('members: limit/offset forwarded + total + hasMore', res.statusCode === 200 && res.body.total === 250 && res.body.hasMore === true
      && memberQueries.some((q) => q.params && q.params[1] === 100 && q.params[2] === 100), JSON.stringify({ body: res.body, q: memberQueries.map((q) => q.params) }));

    // ── Resend delivery webhooks (audit #37) ──
    const resendHook = require(path + '/server/webhooks/resend.js');
    const WHSEC = 'whsec_' + Buffer.from('resend-test-secret').toString('base64');
    process.env.RESEND_WEBHOOK_SECRET = WHSEC;

    let suppressions = [];
    function resendClient() {
      return fakeClient([
        [/insert into suppression_list/, ({ params }) => { suppressions.push(params); return { rows: [] }; }],
        [/insert into activity_feed/, () => ({ rows: [] })],
      ]);
    }

    const bounceEvent = JSON.stringify({ type: 'email.bounced', data: { to: 'gone@x.com', tags: ['org:org-1', 'member:member-1'] } });
    const ts = Math.floor(Date.now() / 1000);
    const signed = (body, id) => {
      const sig = crypto.createHmac('sha256', Buffer.from(WHSEC.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
      return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': 'v1,' + sig };
    };

    res = await call(resendHook, makeReq('POST', { headers: { 'x-nothing': '1' }, body: bounceEvent }));
    check('resend: missing svix headers → 400', res.statusCode === 400, String(res.statusCode));
    res = await call(resendHook, makeReq('POST', { headers: { 'svix-id': 'msg_1', 'svix-timestamp': String(ts - 99999), 'svix-signature': 'v1,AAAA' }, body: bounceEvent }));
    check('resend: stale timestamp → 400', res.statusCode === 400, String(res.statusCode));

    suppressions = [];
    CURRENT_CLIENT = resendClient();
    res = await call(resendHook, makeReq('POST', { headers: signed(bounceEvent, 'msg_2'), body: bounceEvent }));
    check('resend: bounce → suppressed for the right org/email', res.statusCode === 200 && res.body.action === 'suppressed' && suppressions.length === 1 && suppressions[0][1] === 'org-1' && suppressions[0][3] === 'gone@x.com' && suppressions[0][2] === 'member-1', JSON.stringify(suppressions));

    const complaint = JSON.stringify({ type: 'email.complained', data: { to: 'angry@x.com', tags: ['org:org-1'] } });
    suppressions = [];
    CURRENT_CLIENT = resendClient();
    res = await call(resendHook, makeReq('POST', { headers: signed(complaint, 'msg_3'), body: complaint }));
    check('resend: complaint → suppressed', res.statusCode === 200 && suppressions.length === 1 && suppressions[0][3] === 'angry@x.com', JSON.stringify(suppressions));

    const untagged = JSON.stringify({ type: 'email.bounced', data: { to: 'x@y.com' } });
    CURRENT_CLIENT = resendClient();
    res = await call(resendHook, makeReq('POST', { headers: signed(untagged, 'msg_4'), body: untagged }));
    check('resend: untagged email → 200 unmapped (no crash)', res.statusCode === 200 && res.body.action === 'unmapped', JSON.stringify(res.body));

    const delivered = JSON.stringify({ type: 'email.delivered', data: { to: 'ok@x.com', tags: ['org:org-1'] } });
    suppressions = [];
    CURRENT_CLIENT = resendClient();
    res = await call(resendHook, makeReq('POST', { headers: signed(delivered, 'msg_5'), body: delivered }));
    check('resend: delivered → ignored, nothing suppressed', res.statusCode === 200 && res.body.action === 'ignored' && suppressions.length === 0, JSON.stringify(res.body));

    delete process.env.RESEND_WEBHOOK_SECRET;
    res = await call(resendHook, makeReq('POST', { body: bounceEvent }));
    check('resend: no secret configured → 503', res.statusCode === 503, String(res.statusCode));

    // ── local JWT verification (audit #66) ──
    process.env.SUPABASE_JWT_SECRET = 'jwt-secret-for-tests';
    const SUPA_URL = 'https://zujmouzzqiovgbnanrvv.supabase.co';
    const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const jwtSign = (payload) => {
      const head = b64u({ alg: 'HS256', typ: 'JWT' });
      const body = b64u(payload);
      const sig = crypto.createHmac('sha256', 'jwt-secret-for-tests').update(head + '.' + body).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return head + '.' + body + '.' + sig;
    };
    const goodJwt = jwtSign({ sub: 'sbu-1', email: 'owner@test.com', exp: Math.floor(Date.now() / 1000) + 3600, iss: SUPA_URL + '/auth/v1', aud: 'authenticated' });
    // reuse the dashboard-data fake client shape from batch-2
    CURRENT_CLIENT = fakeClient([
      AUTH_BY_SBUID,
      [/with weeks as/, () => ({ rows: [] })],
      [/from recovery_attributions/, () => ({ rows: [{ current_cents: 0, prior_cents: 0 }] })],
      [/as open_case_count/, () => ({ rows: [{ amount_cents: 0, open_case_count: 0 }] })],
      [/filter \(where status = 'recovered'\)/, () => ({ rows: [{ recovered_count: 0, closed_count: 0 }] })],
      [/select status, count\(\*\)::int as count/, () => ({ rows: [] })],
      [/select decline_code,/, () => ({ rows: [] })],
      [/from recovery_cases rc\s+join stripe_members/, () => ({ rows: [] })],
      [/from activity_feed/, () => ({ rows: [] })],
      [/select pilot_started_at, pilot_ends_at from organizations/, () => ({ rows: [] })],
      [/select currency from recovery_cases/, () => ({ rows: [] })],
    ]);
    USERINFO_CALLS = 0;
    const dashMod = require(path + '/server/dashboard-data.js');
    res = await call(dashMod, makeReq('GET', { headers: { authorization: 'Bearer ' + goodJwt }, query: '?range=30d' }));
    check('JWT auth: local verify works (200) with ZERO userinfo calls', res.statusCode === 200 && USERINFO_CALLS === 0, 'status=' + res.statusCode + ' userinfo=' + USERINFO_CALLS);
    const badSigJwt = goodJwt.slice(0, -3) + 'aaa';
    res = await call(dashMod, makeReq('GET', { headers: { authorization: 'Bearer ' + badSigJwt }, query: '?range=30d' }));
    check('JWT auth: bad signature → 401', res.statusCode === 401, String(res.statusCode));
    const expiredJwt = jwtSign({ sub: 'sbu-1', exp: Math.floor(Date.now() / 1000) - 10, iss: SUPA_URL + '/auth/v1', aud: 'authenticated' });
    res = await call(dashMod, makeReq('GET', { headers: { authorization: 'Bearer ' + expiredJwt }, query: '?range=30d' }));
    check('JWT auth: expired token → 401', res.statusCode === 401, String(res.statusCode));
    delete process.env.SUPABASE_JWT_SECRET;
    USERINFO_CALLS = 0;
    res = await call(dashMod, makeReq('GET', { headers: AUTH, query: '?range=30d' }));
    check('JWT auth: without secret falls back to userinfo call', res.statusCode === 200 && USERINFO_CALLS >= 1, 'userinfo=' + USERINFO_CALLS);

    // ── Upstash-backed durable rate limit (audit #10) ──
    const router = require(path + '/api/[...route].js');
    process.env.UPSTASH_REDIS_REST_URL = 'https://example-cache.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    UPSTASH_RESPONSE = () => [{ result: 31 }, { result: 60 }]; // already over the limit
    UPSTASH_CALLS = [];
    res = await call(router, apiReq('POST', 'leads', { headers: { 'x-forwarded-for': '198.51.100.7' }, body: JSON.stringify({ email: 'a@b.com' }) }));
    check('rate limit (Upstash): over-limit count → 429 without touching the handler', res.statusCode === 429 && UPSTASH_CALLS.length === 1 && /rl:/.test(String(UPSTASH_CALLS[0].body)), JSON.stringify({ status: res.statusCode, body: UPSTASH_CALLS[0] && UPSTASH_CALLS[0].body }));
    UPSTASH_RESPONSE = () => [{ result: 1 }, { result: 60 }];
    UPSTASH_CALLS = [];
    res = await call(router, apiReq('POST', 'leads', { headers: { 'x-forwarded-for': '198.51.100.8' }, body: JSON.stringify({ email: 'bad' }) }));
    check('rate limit (Upstash): under limit reaches the handler (400 invalid email)', res.statusCode === 400 && UPSTASH_CALLS.length === 1, 'status=' + res.statusCode);
    // Redis down → in-memory fallback, request still served
    global.fetch = async (url, options) => {
      const u = String(url);
      if (u.includes('/auth/v1/user')) { USERINFO_CALLS += 1; return prevFetch(url, options); }
      if (u.includes('upstash')) throw new Error('redis unreachable');
      return prevFetch(url, options);
    };
    res = await call(router, apiReq('POST', 'leads', { headers: { 'x-forwarded-for': '198.51.100.9' }, body: JSON.stringify({ email: 'bad' }) }));
    check('rate limit: Redis unreachable → falls back to in-memory, request served', res.statusCode === 400, String(res.statusCode));
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    // ── cron: retention sweep + digest generation (audit #14/#54) ──
    const cronMod = require(path + '/server/cron/process-recovery-queue.js');
    let cronQueries = [];
    CURRENT_CLIENT = fakeClient([
      TXN, SAVEPOINT,
      [/set status = 'failed',[\s\S]*'stale'/, () => ({ rows: [] })],
      [/delete from webhook_events/, ({ sql, params }) => { cronQueries.push({ kind: 'retention', sql, params }); return { rows: [] }; }],
      [/insert into forensics_digests/, ({ sql }) => { cronQueries.push({ kind: 'digest', sql }); return { rows: [], rowCount: 2 }; }],
      [/from recovery_cases rc\s+join organizations/, () => ({ rows: [] })],
    ]);
    res = await call(cronMod, makeReq('GET', { headers: { authorization: 'Bearer cron-secret-test' } }));
    check('cron: retention sweep runs with 30-day default', res.statusCode === 200 && cronQueries.some((q) => q.kind === 'retention' && /30 days|make_interval/.test(q.sql) && Number(q.params[0]) === 30), JSON.stringify(cronQueries.find((q) => q.kind === 'retention') && cronQueries.find((q) => q.kind === 'retention').params));
    check('cron: weekly digest upserted (on conflict org+week)', cronQueries.some((q) => q.kind === 'digest' && /on conflict \(organization_id, week_start_date\)/.test(q.sql)), 'digest queries: ' + cronQueries.filter((q) => q.kind === 'digest').length);

    // ── webhook: subscription + refund events (audit #24) ──
    const webhook = require(path + '/server/webhooks/razorpay.js');
    const WSECRET = 'whsec_test';
    const whClient = (extra) => fakeClient([
      TXN, SAVEPOINT,
      [/from stripe_connections/, () => ({ rows: [{ organization_id: 'org-1', webhook_secret: WSECRET }] })],
      [/insert into webhook_events/, () => ({ rows: [{ id: 'we-' + Math.random().toString(36).slice(2) }] })],
      [/from webhook_events[\s\S]*stripe_event_id = \$1/, () => ({ rows: [] })],
      [/update webhook_events/, () => ({ rows: [] })],
      [/from stripe_members/, () => ({ rows: [MEMBER_ROW] })],
      [/update stripe_members/, () => ({ rows: [MEMBER_ROW] })],
      [/from stripe_subscriptions/, () => ({ rows: [] })],
      [/insert into stripe_subscriptions/, ({ params }) => { (extra && extra.subs ? extra.subs : []).push(params); return { rows: [] }; }],
      [/from recovery_cases/, ({ l }) => ({ rows: l.startsWith('select') ? (extra && extra.openCase ? [extra.openCase] : []) : [] })],
      [/update recovery_cases/, () => ({ rows: [{ id: 'case-open' }] })],
      [/insert into recovery_cases/, () => ({ rows: [{ id: 'case-new' }] })],
      [/insert into recovery_attributions/, ({ params }) => { (extra && extra.attrs ? extra.attrs : []).push(params); return { rows: [] }; }],
      [/insert into activity_feed/, ({ params }) => { (extra && extra.acts ? extra.acts : []).push(params); return { rows: [] }; }],
      [/select alert_webhook_url/, () => ({ rows: [{ alert_webhook_url: null, alert_min_amount_cents: 0 }] })],
    ]);
    async function whPost(event, payload, extra) {
      CURRENT_CLIENT = whClient(extra);
      FETCH_LOG = [];
      const raw = JSON.stringify({ event, payload });
      const sig = crypto.createHmac('sha256', WSECRET).update(raw).digest('hex');
      return call(webhook, makeReq('POST', { headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt-' + event + '-' + Math.random().toString(36).slice(2, 7) }, query: '?org=org-1', body: raw }));
    }

    let subs = [], acts = [];
    res = await whPost('subscription.halted', { subscription: { entity: { id: 'sub_h1', status: 'halted', customer_id: 'cust_1', currency: 'INR' } } }, { subs, acts });
    check('webhook: subscription.halted → upsert halted + activity', res.statusCode === 200 && res.body.action === 'subscription_halted' && subs.length === 1 && subs[0][4] === 'halted' && acts.some((a) => a[2] === 'subscription_halted'), JSON.stringify({ body: res.body, subs: subs.length, acts: acts.map((a) => a[2]) }));

    subs = []; acts = [];
    res = await whPost('subscription.cancelled', { subscription: { entity: { id: 'sub_c1', status: 'cancelled', customer_id: 'cust_1' } } }, { subs, acts });
    check('webhook: subscription.cancelled → upsert cancelled + activity', res.statusCode === 200 && subs.length === 1 && subs[0][4] === 'cancelled' && acts.some((a) => a[2] === 'subscription_cancelled'), JSON.stringify(res.body));

    acts = [];
    res = await whPost('refund.processed', { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_big', amount: 20000, currency: 'INR' } } }, { acts });
    check('webhook: refund.processed → refund activity row', res.statusCode === 200 && res.body.action === 'refund_processed' && acts.some((a) => a[2] === 'refund_processed'), JSON.stringify({ body: res.body, acts: acts.map((a) => a[2]) }));

    let attrs = [];
    res = await whPost('subscription.charged', { payment: { entity: { id: 'pay_subch', amount: 25000, currency: 'INR', status: 'captured', email: 'a@b.com' } }, subscription: { entity: { id: 'sub_ch1', status: 'active', customer_id: 'cust_1' } } }, { attrs, openCase: { id: 'case-open', member_id: 'member-1', amount_cents: 25000, currency: 'INR' }, subs: [] });
    check('webhook: subscription.charged → capture path (recovered + attribution)', res.statusCode === 200 && res.body.action === 'case_recovered' && attrs.length === 1, JSON.stringify({ body: res.body, attrs: attrs.length }));
  } finally {
    global.fetch = prevFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
async function testBatch4() {
  console.log('\n── batch-4 (2nd-opinion audit): webhook 500, refunds, resend guard, ytd, search, approve, replay, SMS STOP ──');

  const savedEnv = {};
  for (const key of ['ENCRYPTION_KEY', 'CRON_SECRET', 'GEMINI_API_KEY', 'RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'TWILIO_AUTH_TOKEN']) {
    savedEnv[key] = process.env[key];
  }
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key';
  process.env.CRON_SECRET = 'cron-secret-test';
  process.env.GEMINI_API_KEY = 'gem-test';
  process.env.RESEND_API_KEY = 're-test';
  process.env.RESEND_FROM_EMAIL = 'hello@revessent.com';

  let RESEND_CALLS = [];
  const prevFetch = global.fetch;
  global.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return { ok: true, status: 200, json: async () => SUPABASE_USER };
    if (u.includes('generativelanguage.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Hi, your payment did not go through — please update your payment method. Team Acme.' }] } }] }) };
    }
    if (u.includes('api.resend.com/emails')) { RESEND_CALLS.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ id: 're-1' }) }; }
    return prevFetch(url, options);
  };

  try {
    // ── #3: outer transaction failure → 500 (was 200) ──
    const webhook = require(path + '/server/webhooks/razorpay.js');
    const WSECRET = 'whsec_test';
    let failFirstQuery = false;
    CURRENT_CLIENT = {
      release() {},
      async query() { throw new Error('simulated connection failure'); },
    };
    const rawFail = JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_x', amount: 100, currency: 'INR', status: 'failed', email: 'a@b.com' } } } });
    const sigFail = crypto.createHmac('sha256', WSECRET).update(rawFail).digest('hex');
    let res = await call(webhook, makeReq('POST', { headers: { 'x-razorpay-signature': sigFail, 'x-razorpay-event-id': 'evt-fail-1' }, query: '?org=org-1', body: rawFail }));
    check('webhook: DB transaction failure → 500 (Razorpay retries)', res.statusCode === 500, String(res.statusCode));

    // ── #4: refunds reverse attribution (net revenue), idempotent ──
    let refundUpdates = [];
    const whClient = () => fakeClient([
      TXN, SAVEPOINT,
      [/from stripe_connections/, () => ({ rows: [{ organization_id: 'org-1', webhook_secret: WSECRET }] })],
      [/insert into webhook_events/, () => ({ rows: [{ id: 'we-' + Math.random().toString(36).slice(2) }] })],
      [/from webhook_events[\s\S]*stripe_event_id = \$1/, () => ({ rows: [] })],
      [/update webhook_events/, () => ({ rows: [] })],
      [/update recovery_attributions[\s\S]*refunded_cents/, ({ sql, params }) => { refundUpdates.push({ sql, params }); return { rows: [] }; }],
      [/insert into activity_feed/, ({ params }) => { refundUpdates.acts = refundUpdates.acts || []; refundUpdates.acts.push(params); return { rows: [] }; }],
    ]);
    async function postEvent(event, payload) {
      CURRENT_CLIENT = whClient(); FETCH_LOG = [];
      const raw = JSON.stringify({ event, payload });
      const sig = crypto.createHmac('sha256', WSECRET).update(raw).digest('hex');
      return call(webhook, makeReq('POST', { headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt-' + Math.random().toString(36).slice(2, 8) }, query: '?org=org-1', body: raw }));
    }
    res = await postEvent('refund.processed', { refund: { entity: { id: 'rfnd_9', payment_id: 'pay_big', amount: 4000, currency: 'INR' } } });
    check('refund: attribution refunded_cents updated (least-capped)', res.statusCode === 200 && refundUpdates.length === 1
      && refundUpdates[0].params[0] === 'org-1' && refundUpdates[0].params[1] === 4000 && refundUpdates[0].params[2] === 'pay_big'
      && /least\(amount_cents/.test(refundUpdates[0].sql), JSON.stringify(refundUpdates[0] && refundUpdates[0].params));

    // ── #2: link-payment recovery reconciles the member's latest subscription ──
    let subUpserts = [];
    const capClient = fakeClient([
      TXN, SAVEPOINT,
      [/from stripe_connections/, () => ({ rows: [{ organization_id: 'org-1', webhook_secret: WSECRET }] })],
      [/insert into webhook_events/, () => ({ rows: [{ id: 'we-' + Math.random().toString(36).slice(2) }] })],
      [/from webhook_events[\s\S]*stripe_event_id = \$1/, () => ({ rows: [] })],
      [/update webhook_events/, () => ({ rows: [] })],
      [/from stripe_members/, () => ({ rows: [MEMBER_ROW] })],
      [/update stripe_members/, () => ({ rows: [MEMBER_ROW] })],
      [/from stripe_subscriptions[\s\S]*order by created_at desc/, () => ({ rows: [{ stripe_subscription_id: 'sub_latest' }] })],
      [/from stripe_subscriptions/, () => ({ rows: [] })],
      [/insert into stripe_subscriptions/, ({ params }) => { subUpserts.push(params); return { rows: [] }; }],
      [/from recovery_cases/, ({ l }) => ({ rows: l.startsWith('select') ? [{ id: 'case-open', member_id: 'member-1', amount_cents: 25000, currency: 'INR' }] : [] })],
      [/update recovery_cases/, () => ({ rows: [{ id: 'case-open' }] })],
      [/insert into recovery_attributions/, () => ({ rows: [] })],
      [/insert into activity_feed/, () => ({ rows: [] })],
      [/select alert_webhook_url/, () => ({ rows: [{ alert_webhook_url: null, alert_min_amount_cents: 0 }] })],
    ]);
    CURRENT_CLIENT = capClient; FETCH_LOG = [];
    const rawCap = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_link', amount: 25000, currency: 'INR', status: 'captured', email: 'a@b.com' } } } });
    const sigCap = crypto.createHmac('sha256', WSECRET).update(rawCap).digest('hex');
    res = await call(webhook, makeReq('POST', { headers: { 'x-razorpay-signature': sigCap, 'x-razorpay-event-id': 'evt-linkcap-1' }, query: '?org=org-1', body: rawCap }));
    check('recovery contract: link payment → latest subscription reconciled to active', res.statusCode === 200 && res.body.action === 'case_recovered' && subUpserts.length === 1 && subUpserts[0][3] === 'sub_latest' && subUpserts[0][4] === 'active', JSON.stringify({ body: res.body, subs: subUpserts.map((s) => [s[3], s[4]]) }));

    // ── #5: already-sent note → 409 ──
    const sendNote = require(path + '/server/recovery/send-note.js');
    CURRENT_CLIENT = fakeClient([
      AUTH_BY_SBUID,
      [/from recovery_notes rn[\s\S]*join recovery_cases/, () => ({ rows: [{ id: 'note-sent', organization_id: 'org-1', case_id: 'case-1', subject: 's', body: 'b', sent_at: '2026-09-01T00:00:00Z', member_id: 'member-1', member_email: 'a@b.com', case_status: 'detected', organization_name: 'Acme' }] })],
    ]);
    res = await call(sendNote, makeReq('POST', { headers: AUTH, body: JSON.stringify({ noteId: 'note-sent', autoSend: true }) }));
    check('send-note: resending a sent note → 409', res.statusCode === 409, JSON.stringify(res.body));

    // ── #6: YTD is a real year-to-date range ──
    const dash = require(path + '/server/dashboard-data.js');
    let ytdParam = null;
    CURRENT_CLIENT = fakeClient([
      AUTH_BY_SBUID,
      [/with weeks as/, () => ({ rows: [] })],
      [/from recovery_attributions/, ({ params }) => { ytdParam = params; return { rows: [{ current_cents: 0, prior_cents: 0 }] }; }],
      [/as open_case_count/, () => ({ rows: [{ amount_cents: 0, open_case_count: 0 }] })],
      [/filter \(where status = 'recovered'\)/, () => ({ rows: [{ recovered_count: 0, closed_count: 0 }] })],
      [/select status, count\(\*\)::int as count/, () => ({ rows: [] })],
      [/select decline_code,/, () => ({ rows: [] })],
      [/from recovery_cases rc\s+join stripe_members/, () => ({ rows: [] })],
      [/from activity_feed/, () => ({ rows: [] })],
      [/select pilot_started_at, pilot_ends_at from organizations/, () => ({ rows: [] })],
      [/select currency from recovery_cases/, () => ({ rows: [] })],
    ]);
    res = await call(dash, makeReq('GET', { headers: AUTH, query: '?range=ytd' }));
    const now = new Date();
    const expectedDays = Math.max(1, Math.ceil((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 1)) / 864e5));
    check('dashboard: range=ytd computes real year-to-date days', res.statusCode === 200 && ytdParam && ytdParam[1] === expectedDays, 'param=' + (ytdParam && ytdParam[1]) + ' expected=' + expectedDays);
    check('dashboard: recovered revenue is NET of refunds', /refunded_cents/.test(require('fs').readFileSync(path + '/server/dashboard-data.js', 'utf8')), 'net sum missing');

    // ── #11: server-side member search ──
    const membersMod = require(path + '/server/members.js');
    let searchParams = null;
    CURRENT_CLIENT = fakeClient([
      AUTH_BY_SBUID,
      [/limit \$2 offset \$3/, ({ params }) => { searchParams = params; return { rows: [] }; }],
      [/select count\(\*\)::int as total from stripe_members/, () => ({ rows: [{ total: 0 }] })],
      [/select member_id, id as case_id/, () => ({ rows: [] })],
    ]);
    res = await call(membersMod, makeReq('GET', { headers: AUTH, query: '?search=priya&limit=50&offset=0' }));
    check('members: search term forwarded to SQL (server-side ilike)', res.statusCode === 200 && searchParams && searchParams[3] === 'priya', JSON.stringify(searchParams));

    // ── #35: bulk approve ──
    const bulk = require(path + '/server/recovery/bulk-approve.js');
    const memberRow = { ...USERS_ROW, role: 'member' };
    CURRENT_CLIENT = fakeClient([[/from users\s+where supabase_user_id/, () => ({ rows: [memberRow] })]]);
    res = await call(bulk, makeReq('POST', { headers: AUTH, body: JSON.stringify({ caseIds: ['case-1'] }) }));
    check('bulk-approve: member → 403', res.statusCode === 403, String(res.statusCode));

    const CASE_CTX = { id: 'case-ap1', organization_id: 'org-1', member_id: 'member-1', status: 'awaiting_approval', member_name: 'Priya', member_email: 'priya@x.com', organization_name: 'Acme', amount_cents: 5000, currency: 'INR', decline_code: 'insufficient_funds' };
    function bulkClient() {
      return fakeClient([
        AUTH_BY_SBUID,
        [/from recovery_cases[\s\S]*status = 'awaiting_approval'/, () => ({ rows: [{ id: 'case-ap1' }, { id: 'case-ap2' }] })],
        [/from recovery_cases rc\s+left join stripe_members/, () => ({ rows: [CASE_CTX] })],
        [/from voice_profiles/, () => ({ rows: [{ brand_name: 'Acme', sender_name: 'Team Acme', sender_email: 'hello@acme.com', tone_description: 'Friendly' }] })],
        [/insert into recovery_notes/, () => ({ rows: [] })],
        [/from suppression_list/, () => ({ rows: [] })],
        [/update recovery_notes/, () => ({ rows: [] })],
        [/set status = 'note_sent'/, () => ({ rows: [] })],
        [/insert into activity_feed/, () => ({ rows: [] })],
        [/insert into audit_log/, () => ({ rows: [] })],
      ]);
    }
    CURRENT_CLIENT = bulkClient(); RESEND_CALLS = [];
    res = await call(bulk, makeReq('POST', { headers: AUTH, body: JSON.stringify({ caseIds: ['case-ap1', 'case-ap2'] }) }));
    check('bulk-approve: owner approves parked cases (emails sent, audited)', res.statusCode === 200 && res.body.eligible === 2 && RESEND_CALLS.length === 2, JSON.stringify(res.body));

    // ── #34: webhook replay ──
    const replay = require(path + '/server/webhooks/replay.js');
    CURRENT_CLIENT = fakeClient([
      AUTH_BY_SBUID,
      [/from webhook_events[\s\S]*stripe_event_id = \$2/, () => ({ rows: [] })],
    ]);
    res = await call(replay, makeReq('POST', { headers: AUTH, body: JSON.stringify({ eventId: 'nope' }) }));
    check('replay: unknown event → 404', res.statusCode === 404, String(res.statusCode));
    res = await call(replay, makeReq('POST', { headers: AUTH, body: JSON.stringify({}) }));
    check('replay: missing eventId → 400', res.statusCode === 400, String(res.statusCode));

    // ── #16: SMS STOP/START inbound (Twilio signature) ──
    const smsHook = require(path + '/server/webhooks/sms-inbound.js');
    const formBody = 'From=%2B919876543210&To=%2B911800123456&Body=STOP&MessageSid=SM123';
    const twUrl = 'https://revessent-alpha.vercel.app/api/webhooks/sms-inbound';
    const twSig = crypto.createHmac('sha1', 'twilio-secret').update(twUrl + 'Body' + 'STOP' + 'From' + '+919876543210' + 'MessageSid' + 'SM123' + 'To' + '+911800123456').digest('base64');
    process.env.TWILIO_AUTH_TOKEN = 'twilio-secret';
    res = await call(smsHook, makeReq('POST', { body: formBody }));
    check('sms-inbound: no/bad signature → 403', res.statusCode === 403, String(res.statusCode));

    let stopInserts = [];
    CURRENT_CLIENT = fakeClient([
      [/insert into suppression_list[\s\S]*from stripe_members/, ({ sql, params }) => { stopInserts.push({ sql, params }); return { rows: [] }; }],
      [/delete from suppression_list/, () => ({ rows: [] })],
    ]);
    // make the raw body a real async iterable with the form content
    const stopReq = { method: 'POST', url: '/api/webhooks/sms-inbound', query: {}, headers: { 'x-twilio-signature': twSig, 'content-type': 'application/x-www-form-urlencoded' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(formBody); } };
    res = await call(smsHook, stopReq);
    check('sms-inbound: signed STOP → suppression by phone across orgs', res.statusCode === 204 && stopInserts.length === 1 && stopInserts[0].params[1] === '+919876543210' && /sm\.phone = \$2/.test(stopInserts[0].sql), JSON.stringify(stopInserts[0] && stopInserts[0].params));

    const startBody = 'From=%2B919876543210&To=%2B911800123456&Body=START&MessageSid=SM124';
    const startSig = crypto.createHmac('sha1', 'twilio-secret').update(twUrl + 'Body' + 'START' + 'From' + '+919876543210' + 'MessageSid' + 'SM124' + 'To' + '+911800123456').digest('base64');
    let startDeletes = [];
    CURRENT_CLIENT = fakeClient([
      [/insert into suppression_list[\s\S]*from stripe_members/, () => ({ rows: [] })],
      [/delete from suppression_list/, ({ params }) => { startDeletes.push(params); return { rows: [] }; }],
    ]);
    const startReq = { method: 'POST', url: '/api/webhooks/sms-inbound', query: {}, headers: { 'x-twilio-signature': startSig, 'content-type': 'application/x-www-form-urlencoded' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(startBody); } };
    res = await call(smsHook, startReq);
    check('sms-inbound: signed START → suppression removed', res.statusCode === 204 && startDeletes.length === 1 && startDeletes[0][0] === '+919876543210', JSON.stringify(startDeletes));

    process.env.TWILIO_AUTH_TOKEN = '';
    res = await call(smsHook, makeReq('POST', { body: formBody }));
    check('sms-inbound: Twilio not configured → 503', res.statusCode === 503, String(res.statusCode));
  } finally {
    global.fetch = prevFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
    await testBatch2();
    await testBatch3();
    await testBatch4();
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
