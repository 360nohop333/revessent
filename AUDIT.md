# Revessent — Audit Response & Fix Checklist

Response to the full audit (items #1–#71 + ADD lists). Status legend:

- ✅ **FIXED** — patched in this pass (see linked file)
- 🔧 **ALREADY OK** — the audit finding was stale/incorrect for the current code; evidence noted
- ⚠️ **NEEDS LIVE VERIFICATION** — depends on your Neon / Supabase / Razorpay settings; SQL or steps provided
- 📋 **DEFERRED** — real, but scoped to the next pass (tracked at the bottom)

---

## SQL TO RUN IN NEON

The canonical migration files now live in `migrations/` and can be applied
with one command (audit #41):

```
DATABASE_URL='postgres://…' npm run migrate
```

It tracks applied files in a `_migrations` table and each file runs in its
own transaction. The same SQL is reproduced below for copy-pasting into the
Neon SQL editor:

```sql
-- users: the column every API actually auths by (audit #40)
ALTER TABLE users ADD COLUMN IF NOT EXISTS supabase_user_id text;
CREATE UNIQUE INDEX IF NOT EXISTS users_supabase_user_id_idx ON users(supabase_user_id);
CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users(lower(email));

-- organizations: slug is never set by signup (audit #40)
ALTER TABLE organizations ALTER COLUMN slug DROP NOT NULL;

-- retry race protection actually enforced (audit #42)
CREATE UNIQUE INDEX IF NOT EXISTS recovery_attempts_idempotency_key_idx
  ON recovery_attempts(idempotency_key);

-- hot-path indexes (audit #42)
CREATE INDEX IF NOT EXISTS recovery_cases_org_status_idx ON recovery_cases(organization_id, status);
CREATE INDEX IF NOT EXISTS activity_feed_org_created_idx ON activity_feed(organization_id, created_at);
CREATE INDEX IF NOT EXISTS recovery_attempts_org_case_idx ON recovery_attempts(organization_id, case_id);

-- recovery_notes.updated_at is written by code (audit #40)
ALTER TABLE recovery_notes ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now();

-- ── batch-2 ──

-- pilot window + trust level (audit #38/#49)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS pilot_started_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS pilot_ends_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS trust_level text NOT NULL DEFAULT 'approval_required';

-- landing-page leads (audit #47)
CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- unsubscribe / suppression (audit #35/#37)
CREATE TABLE IF NOT EXISTS suppression_list (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid,
  email text NOT NULL,
  unsubscribed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppression_list_org_email_idx UNIQUE (organization_id, lower(email))
);

-- privileged-action trail (audit #16) — writes are best-effort; a missing
-- table never breaks the audited action, so this can land any time
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid,
  action text NOT NULL,
  detail jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_org_idx ON audit_log(organization_id, created_at);
```

> `suppression_list_org_email_idx` as a table CONSTRAINT keeps it in `CREATE TABLE IF NOT EXISTS` (a separate `CREATE UNIQUE INDEX` would fail if the table already exists from a partial run). If you created the table earlier without it: `CREATE UNIQUE INDEX IF NOT EXISTS suppression_list_org_email_idx ON suppression_list(organization_id, lower(email));`

---

## Security

| # | Finding | Status | Notes |
|---|---|---|---|
| 1 | `/api/onboard` trusts body email/user id | ✅ FIXED | `server/onboard.js` now derives identity ONLY from a verified Supabase access token (`Authorization: Bearer …`); body credentials are ignored. `login.html` sends the session token. |
| 2 | Email linking without confirmed email | ✅ FIXED | Linking an existing unlinked Neon account now requires `email_confirmed_at` from the verified Supabase token, else 403. |
| 3 | Stored XSS via payer names in `aria-label` | ✅ FIXED | `dashboard.html` queue rows escape names (`esc()`) before attribute interpolation. |
| 4 | No role checks | ✅ FIXED | Owner/admin gate on: settings POST, Razorpay connect, retry, send-note, send-sms, API-key create/revoke, alert send/test. Members keep read access. |
| 5 | Sender email spoofing | ✅ FIXED (blocklist) | `server/settings.js` rejects `@revessent.com`, `@resend.dev`, platform domains. Full fix = per-tenant Resend domain verification — needs YOUR Resend account (verify a domain, point DNS) — then senders can be constrained to verified domains. |
| 6 | "Read-only" claim vs full Key Secret | ✅ FIXED (copy) / 📋 (OAuth) | All "read-only" claims removed from the landing page (now: encrypted at rest, revocable). Keys ARE stored encrypted. True least-privilege = Razorpay OAuth/Partner program — a business/relationship step, not code; 📋 deferred. |
| 7 | Webhook secret plaintext; no key rotation | ✅ FIXED | Webhook secret is now encrypted at rest (`enc:v1:` format; legacy plaintext still verifies). Key rotation supported: set `ENCRYPTION_KEY`=<new> + `ENCRYPTION_KEY_OLD`=<old>, redeploy, re-save the Razorpay connection once per workspace (values re-encrypt on save), then drop `_OLD`. Still **back up `ENCRYPTION_KEY`**. |
| 8 | `rejectUnauthorized:false` | 🔧 ACCEPTED RISK | Standard node-postgres + Neon configuration (Neon's chain isn't in the trust store; TLS still encrypts). Alternative: Neon serverless driver — 📋 deferred. |
| 9 | No security headers | ✅ FIXED | `vercel.json` now sets HSTS, CSP, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy. CSP allows `unsafe-inline` (inline-script pages) but locks connect/img/frame/object sources. |
| 10 | No rate limiting | ✅ FIXED (durable-ready) | The router limits 30 writes/min/IP/route (webhooks + cron exempt). With `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` set it becomes a DURABLE fixed-window counter in Upstash Redis across all instances; without them it's per-warm-instance in memory; if Redis is unreachable it falls back (never blocks traffic). **Your action: create a free Upstash cache and set the two env vars.** |
| 11 | Gemini key in URL | ✅ FIXED | Both `send-note.js` and `send-sms.js` now send `x-goog-api-key` header; no key in any URL. |
| 12 | Prompt injection / no output guardrails | ✅ MITIGATED | Prompts now carry hard rules: never offer discounts/refunds, never include links, never promise reversal, never request card/OTP/password. Full sandboxing: 📋 deferred. |
| 13 | Root files downloadable | ✅ FIXED | Stale root `settings.js` / `dashboard-data.js` deleted; `.vercelignore` excludes `schema.ts`, docs, `.env.example`, `tests/`. |
| 14 | Org UUID in webhook URL; raw payloads kept forever | ✅ FIXED (retention) | UUID-in-URL stays (routing hint, not the auth — the HMAC secret is; Stripe does the same). The nightly cron now deletes `webhook_events` older than 30 days (`WEBHOOK_RETENTION_DAYS`, default 30); the privacy policy states the window. |
| 15 | App-level tenant isolation only | ⚠️ DEFERRED (RLS) | Every query org-scoped or org-checked after fetch (verified in 144 tests). Real RLS needs per-request `SET LOCAL app.organization_id` inside transactions — an invasive refactor of every query — plus policy SQL. Shipping half of it would either do nothing or break the app; deliberately deferred with that explanation. |
| 16 | No MFA / audit log / session mgmt | ✅ FIXED (log + viewer + sign-out) | Audit log writes (api_key.*, razorpay.connected, settings.updated, case.retry, note.sent, organization.deleted) + `GET /api/audit` + an Audit log section in Settings. "Sign out everywhere" (global session revoke) in Settings → Account. MFA itself is a Supabase dashboard toggle — **your action**: enable it there. |

## Money path

| # | Finding | Status | Notes |
|---|---|---|---|
| 17 | Webhook auto-registration may fail | ⚠️ VERIFY | `server/razorpay/connect.js` registers via Razorpay's Webhooks API using your Key ID/Secret. Verify in your dashboard that the webhook appears; manual setup steps are on the ADD list if it fails. |
| 18 | Signature hashes re-serialized body | 🔧 ALREADY OK | The handler HMACs the **raw request bytes** (`readRawBody` → `createHmac().update(buffer)`), not re-serialized JSON. Verified by tests (bad signature → 400, good → 200). |
| 19 | Ignores `x-razorpay-event-id` | ✅ FIXED | Header is now the primary dedupe id; payload fingerprint is the fallback. |
| 20 | 200 on processing failure | ✅ FIXED | Processing failures now return **500** so Razorpay retries, and previously-errored events are **reprocessed** (only cleanly-processed ones dedupe). |
| 21 | `status = any($n::text[])` vs enum | ⚠️ VERIFY | `schema.ts` defines `status` as `text`, which is safe. Run `select data_type from information_schema.columns where table_name='recovery_cases' and column_name='status';` — if it says `USER-DEFINED`, run `ALTER TABLE recovery_cases ALTER COLUMN status TYPE text;` |
| 22 | `recovery_attributions` never written | ✅ FIXED | Recovery (payment.captured on an open case) now inserts a ledger row, guarded against double-counting. Dashboard/export/billing all read it. |
| 23 | `stripe_subscriptions` never written | ✅ FIXED | Live sync on every payment event (captured → `active`, failed → `past_due`) AND historical backfill: `razorpay/backfill.js` now pages `/v1/subscriptions` and upserts each (status, per-cycle amount, member link). Run once via POST /api/razorpay/backfill after connecting. |
| 24 | Only 2 event types handled | ✅ FIXED | Now handled: `payment.failed`, `payment.captured`, `subscription.charged` (runs the capture/recovery path), `subscription.cancelled`/`halted`/`resumed`/`completed` (status sync + activity — halted is the churn alarm), `refund.processed` (visible activity so recovered-then-refunded can't hide). New webhooks are also PATCHed up to the full event set when an existing webhook is reused. |
| 25 | One case per failed payment | 🔧 PARTLY OK | Same payment id → one case (DB-level `on conflict (stripe_invoice_id)`). Separate failed charges create separate cases (arguably correct). No "3 OTP mistypes = 3 cases" for the same payment. |
| 26 | Hard declines retried; no UPI reasons | ✅ FIXED | `upi_mandate_issue` added to the no-auto-retry set everywhere (webhook, retry, backfill, cron): UPI mandate/NACH/Autopay failures park as `awaiting_approval` (customer must fix the mandate). UPI per-transaction-limit errors map to `insufficient_funds` → payday-aware +3d first retry. Both covered by tests. |
| 27 | Guest checkout → NULL member crash | 🔧 ALREADY OK | `findOrCreateMember` creates a member from the payment email/customer id; verified in code and tests. |
| 28 | No scheduler | 🔧 STALE | `server/cron/process-recovery-queue.js` + `vercel.json` cron (daily 03:30 UTC — Hobby's max) already process due cases by `next_retry_at`. It was hourly-incompatible with Hobby, now fixed. |
| 29 | Order + link both created; notify bypasses voice | ✅ FIXED | `notify:{email:false,sms:false}` (no duplicate Razorpay emails) and `callback_method` dropped from link creation; the activity is now type `retry` and carries the checkout URL so it's clickable in the dashboard feed. |
| 30 | No cap on successful retries | 🔧 ALREADY OK | Only cases in open statuses can be retried (`ELIGIBLE_STATUSES`); a recovered case → 400 "not eligible". |
| 31 | API error can condemn good customers | ✅ FIXED | "Lost" is only set when Razorpay **responded** with an error; network/infra failures leave the case open for the next run. |
| 32 | Stuck pending attempt blocks retries; no unique index | ✅ FIXED | Unique index (SQL above) + the cron now sweeps `pending` attempts older than 1h → `failed`/`stale` at the start of every run, so a crashed function can no longer wedge a case's idempotency key. Test-covered. |
| 33 | Retries logged as `note_sent`; link not shown | ✅ FIXED | Retry activity uses type `retry` with the checkout link in the description (see #29). |
| 34 | Re-saving keys registers duplicate webhooks | ✅ FIXED | `connect.js` now LISTS existing webhooks first and reuses a matching URL (keeping the stored secret) instead of blindly creating a new one; the response says `webhookReused` vs `manualSetup`. Still ⚠️ VERIFY once against your live Razorpay account. Webhook deletion/disconnect UI: 📋 deferred. |
| 35 | Email template gaps (CTA, unsubscribe, plain-text, autoSend) | ✅ FIXED | Every recovery email now has: a one-click unsubscribe link (`/api/unsubscribe?token=…`, HMAC-signed with `ENCRYPTION_KEY`), a plain-text alternative, `reply_to` the sender, and a footer explaining why the email arrived. `autoSend` stamps `approved_at`/`approved_by_user_id` (the click IS the approval). Token round-trip + footer asserted in tests. |
| 36 | `gemini-2.0-flash` retired | ✅ FIXED | `GEMINI_MODEL` env var, default `gemini-2.5-flash`; document in README/.env.example. |
| 37 | No Resend webhooks / suppression / SPF-DKIM flow | ✅ FIXED (app side) | Suppression list + `/api/unsubscribe` (from batch-2) PLUS `POST /api/webhooks/resend`: Svix-signed delivery events; bounces/complaints auto-suppress the address (emails are tagged `org:`/`member:` for mapping) and log an activity. **Your action:** add the webhook in Resend → Webhooks (URL `/api/webhooks/resend`, events bounce/complaint) and set `RESEND_WEBHOOK_SECRET`. SPF/DKIM remains DNS work on your domain. |
| 38 | Approval / trust levels not enforced | ✅ FIXED | `organizations.trust_level` (default `approval_required`) now gates the cron: while approval is required, the scheduler NEVER emails a customer — it parks the case as `awaiting_approval` + logs an activity for a human. Manual owner/admin sends are unaffected (that click is the approval). Bulk-approve UI: 📋 deferred. |
| 39 | Phone as name; 2-decimal currencies | ✅ FIXED | Phone-like strings blanked on member upsert, and zero-decimal currencies (JPY/KRW/VND/…) no longer divide by 100 — in the email/SMS amount labels, the dashboard counters and the chart axis. |

## Database

| # | Finding | Status | Notes |
|---|---|---|---|
| 40 | schema.ts drift | ✅ FIXED | `users.supabase_user_id`, `recovery_notes.updated_at`, nullable `slug` added; ALTER SQL above. |
| 41 | No migrations/seed | ✅ FIXED | `migrations/0001…0003.sql` + `scripts/migrate.js` (`npm run migrate`) — ordered, tracked in a `_migrations` table, one transaction per file. Seed data: still none by design. |
| 42 | Missing constraints/indexes | ✅ FIXED | SQL above: unique `supabase_user_id`, unique `idempotency_key`, `(org,status)`, `(org,created_at)`, `lower(email)`. |
| 43 | `stripe_*` naming; dead Better Auth tables | 📋 DEFERRED (deliberate) | Renaming to `payment_*` requires running the rename SQL and deploying the matching code in the same window — doing the SQL alone breaks the app, doing the code alone breaks the app. Deferred until there's a quiet window; `scripts/migrate.js` makes it a two-command operation when you want it. |
| 44 | No team table | 📋 DEFERRED | Single-owner model today; roles exist on `users`. |
| 45 | 12 pools risk connection exhaustion | ✅ FIXED | Every `new Pool()` is `max: 1` (serverless-safe with Neon). README recommends the pooled connection string. |
| 46 | Dashboard queries serial; wrong range; closed-status constant | ✅ FIXED | All 8 metrics now run via one `Promise.all`; recovery rate is scoped to the selected range (7/30/90d) with a ±range prior window; the lying `OPEN_CASE_STATUSES` constant renamed `CLOSED_CASE_STATUSES_SQL` (and the two call sites the rename had missed — caught by the new tests); the invented "industry average" is gone. |

## Fake UI & promises

| # | Finding | Status | Notes |
|---|---|---|---|
| 47 | Lead forms go nowhere | ✅ FIXED | New public `POST /api/leads` (validated email, source tag, rate-limited) writes to a `leads` table (SQL above). All three landing-page forms submit for real — the success chip only appears after the server confirms the save — and the sign-in card's "Request pilot access" captures the typed email too. |
| 48 | Fake "Connect Razorpay" | ✅ FIXED | The dashboard connect card no longer fakes a connection — any submit routes to `/settings.html`, where the real (encrypted, webhook-registering) connect flow lives. Button copy says "Connect in Settings". |
| 49 | Upgrade toast; pilot card; refund guarantee | ✅ FIXED | Real 14-day pilot window at signup + live countdown card. The unenforceable "90-day refund guarantee" copy is GONE from the landing page — replaced with the honest, verifiable offer (attribution ledger + free pilot). |
| 50 | Pricing page oversells | ✅ FIXED | Every plan bullet now names something that exists (alerts, API keys, exports, roles, audit log, digests); "SSO/SAML", "concierge", "99.9% SLA", "tone A/B tests", "upgrade signals" claims removed; header says billing switches on at launch; prices in ₹. |
| 51 | $ vs ₹; invented benchmarks | ✅ FIXED | Workspace-currency formatting everywhere (dashboard KPIs, chart axis, plan cards ₹, amount labels), invented benchmark gone. Per-viewer locale selection (i18n) stays a product decision — 📋 deferred deliberately. |
| 52 | Sign out / profile email / avatar hard-coded | ✅ FIXED | Sign-out wired (`supabase.auth.signOut()` → login); profile email + initials from the session. |
| 53 | Silent $0 on API failure | ✅ FIXED | 401 → redirect to login; other failures now show a persistent, dismissible error banner (not just a vanishing toast) above the empty state. |
| 54 | Digest page dead; legal 404 | ✅ FIXED | The nightly cron now generates/updates the weekly `forensics_digests` row per org (failed/recovered/lost counts, recovered/lost amounts, top-3 decline reasons, plain narrative — no AI spend in the cron) with `on conflict (organization_id, week_start_date)`; the digest page reads them. Migration 0003 ensures the unique index. Legal drafts remain DRAFT pending counsel. |

## Auth & accounts

| # | Finding | Status | Notes |
|---|---|---|---|
| 55 | Signup assumes session | ✅ FIXED | No-session signup now shows "check your inbox and confirm your email" instead of a fake redirect. |
| 56 | Forgot-password dead-end | ✅ FIXED | `reset-password.html` exists (audit #56): the reset email redirects here (explicit `redirectTo`), a recovery session is required, password + confirm validated, then sent to Supabase `updateUser`. Still ⚠️ VERIFY the Supabase email template doesn't override the redirect. |
| 57 | Fire-and-forget onboarding sync | ✅ FIXED | `login.html` now awaits the sync before redirecting. |
| 58 | `onboarding.html` orphaned | ✅ FIXED | Deleted (nothing linked to it; login.html owns onboarding). |
| 59 | Token read once; no refresh | ✅ FIXED | supabase-js auto-refresh stays, and the dashboard now reacts to a 401 by refreshing the session once and retrying BEFORE redirecting to login — a long-idle tab recovers itself instead of logging you out. |
| 60 | No email/password change, delete, export | ✅ FIXED | Settings → Account: change password (Supabase `updateUser`), sign out everywhere (global session revoke), delete workspace (owner-only, typed `DELETE` confirmation, cascades all org data + final audit row). CSV exports already covered business data. The Supabase login itself can't be deleted without a service-role key — the UI says so and points to support. |

## Frontend / ops

| # | Finding | Status | Notes |
|---|---|---|---|
| 61 | Monolithic HTML files | 📋 DEFERRED | Deliberate no-build choice; revisit if the team grows. |
| 62 | Cloudflare junk scripts; heavy visuals | ✅ FIXED | CF junk stripped (batch-1). Landing page now hints the eco path immediately on low-core/Android devices (dpr + CSS shed weight at once; the FPS probe still owns the full downgrade), alongside the existing reduced-motion support and dashboard eco gating. |
| 63 | Hash routes, no OG/sitemap/robots | ✅ FIXED (SEO) | `robots.txt` (app pages + API disallowed) + `sitemap.xml` (public pages) + OG/Twitter/canonical meta. Hash routes remain a deliberate no-build choice (see #61). |
| 64 | No pagination/search; member cap | ✅ FIXED | `/api/members` takes `limit` (cap 200) + `offset` and returns `total` + `hasMore`; the members page grows a "Load more (x of y shown)" button. (The endpoint tests caught a real destructuring bug here before it shipped.) |
| 65 | Two stacks mashed; env docs wrong; KEY_ vs ENCRYPTION_ | ✅ FIXED | `.env.example` rewritten for the real stack (Neon/Supabase/Razorpay/Gemini/Resend + ENCRYPTION_KEY/CRON_SECRET/PUBLIC_APP_URL); old Better Auth/Stripe/Next values gone. README's table is the source of truth. Dead `onboarding.html` still to delete (see #58). |
| 66 | Copy-pasted auth; hardcoded Supabase creds | ✅ FIXED | ONE shared module (`server/_lib/supabase-auth.js`) replaces the byte-identical auth block in 18 handlers. With `SUPABASE_JWT_SECRET` set, access tokens are verified locally (HS256: signature/exp/iss/aud — zero per-request Supabase calls); without it, the userinfo call remains. Frontend: every page loads `/api/config.js` (env-sourced Supabase project) with the inline fallback kept. **Your action (optional):** copy the JWT secret from Supabase → Settings → API into the env var. |
| 67 | No tests/CI/README/gitignore | ✅ FIXED | Suite now **144 checks** (batch-3 adds: secret-box rotation, audit endpoint + gates, org delete, members pagination, Resend webhook signatures + suppression, local JWT auth, Upstash limiter + fallback, cron retention/digest, subscription/refund events) and it has caught three real bugs before shipping. GitHub Actions CI (`.github/workflows/ci.yml`) runs the suite + the single-function guard on every PR. Lint/TS: 📋 deferred. |
| 68 | **23 functions > Hobby's 12 cap — deploys fail** | ✅ FIXED | **All endpoints consolidated into ONE function** (`api/[...route].js` → `server/*`). This was silently breaking every deployment of this branch. Note: Hobby is also non-commercial — Pro before charging customers. |
| 69 | No legal pages | ✅ PARTIAL | Draft Terms + Privacy published & linked (review with counsel; India DPDP + GDPR framed). |
| 70 | Messaging compliance (unsubscribe, TRAI/DLT, RBI) | 📋 DEFERRED | Do not enable SMS/auto-debit until reviewed. |
| 71 | Honest-copy pass | ✅ FIXED | With #6 (no more "read-only" claims), #49 (guarantee → verifiable attribution), #50 (pricing bullets = real features, billing-not-live stated). |

## ADD list — what's genuinely left

1. **Your accounts, not code:** Upstash env vars (#10), Resend webhook + secret (#37), Resend domain verification (#5/#37 SPF-DKIM), Supabase MFA toggle (#16), optional `SUPABASE_JWT_SECRET` (#66), counsel review of terms/privacy (#69), TRAI/DLT + RBI review before SMS/auto-debit (#70), Razorpay OAuth/Partner (#6).
2. **Bulk-approve UI** for `awaiting_approval` cases (#38 tail).
3. **Sentry/error tracking + webhook replay UI.**
4. **`stripe_*` → `payment_*` rename + RLS** — coordinated SQL+deploy windows (#15/#43); `npm run migrate` makes the SQL half a one-command operation when you're ready.
5. **Lint/typecheck, hash-route cleanup, per-viewer i18n** (#51 tail, #61).
6. Then the "Next"/"Later" product items (smart timing, more processors, billing for Revessent itself).

## Verification

- `node --check` across all server modules + router: clean.
- `npm test` → **144/144**. Batches 1–2 covered: router dispatch, onboard
  token security, role gates, sender blocklist, webhook signature/dedupe/
  500-retry/reprocess, attribution ledger, retry guards, API-key lifecycle,
  CSV escaping, lead capture, unsubscribe round-trip + suppression 409,
  unsubscribe footer/plain-text/reply-to, in-memory rate limit, UPI decline
  mapping, subscription upsert, phone-name blanking, cron approval gate +
  stale sweep, dashboard currency/pilot. Batch-3 adds: secret-box rotation
  (ENCRYPTION_KEY_OLD, legacy plaintext), audit endpoint + role gate,
  workspace deletion (confirm + audit + cascade), members pagination,
  Resend Svix signature verification (missing/stale/tampered → 400, bounce →
  suppression, complaint → suppression, untagged → unmapped, no-secret → 503),
  local JWT verification (zero userinfo calls, bad signature/expired → 401,
  fallback without secret), Upstash durable limiter (over-limit 429,
  under-limit pass, Redis-down fallback), cron retention sweep + weekly
  digest upsert, and subscription.halted/cancelled + refund.processed +
  subscription.charged event handling.
- The suite caught **three real bugs** before they shipped: undefined
  `cleanString` in the webhook (batch-2), undefined `OPEN_CASE_STATUSES_SQL`
  in two dashboard queries (batch-2), and a Promise.all destructuring swap in
  the members pagination (batch-3) that would have shown total=0 forever.
- `vercel.json` / `package.json` parse; function count = 1 (Hobby-safe).
- CI (`.github/workflows/ci.yml`) runs the suite + the one-function guard on
  every PR and push to main.

---

## Batch 4 — the second-opinion audit (ChatGPT review, items #1–36)

A second reviewer estimated **~72% ship-ready**. I re-verified every claim
against the code: nearly all findings were real. Status after this batch —
**181/181 checks green** (was 144).

**Where I agree / disagree with the 72%:** before batch 4, the number was
fair — the fatal gap was that a **fresh database could not be built**
(no bootstrap migration), which alone blocks any second deployment or
reproducible test environment. With `0000_initial_schema.sql` in place and
the webhook/refund/retry contracts fixed, the remaining risk is
concentrated where code can't reach: RLS at the database (a compromised
anon key still reads everything), email deliverability, and legal review.
Code-side I'd now call it production-grade for the pilot; **infrastructure
and compliance are the long pole.**

### Fixed in this batch

| # | Finding | Fix |
|---|---------|-----|
| 1 | No fresh-DB migration | `migrations/0000_initial_schema.sql` — full bootstrap, mirrors prod shape; runner now 5 files |
| 2 | Payment-link retry isn't a true subscription retry | Documented contract (**Option B**): the link collects the failed balance, the webhook then explicitly reconciles the member's latest subscription to `active` — no silent divergence |
| 3 | Webhook returns 200 even when the DB write fails | Outer transaction failure → **500**, so Razorpay retries; dedupe still idempotent on retry |
| 4 | Refunds don't reverse attribution | `refunded_cents` on `recovery_attributions` (least-capped, idempotent); **every revenue reader is now net** (dashboard, digest, v1 summary, CSV export) |
| 5 | Sent notes can be resent | `send-note` → **409** ("Draft a new note instead") |
| 6 | YTD range computed client-side only / wrong | `?range=ytd` handled server-side (days since UTC Jan 1); client mirrors it |
| 7 | Dead nav links (signals/docs tabs) | Removed; "What's new" → `/changelog.html`, Activity "View all" → `/weekly-digest.html`, mobile signals → digest, overview → `#kpis` |
| 9 | Dead account menu | Profile → `/settings.html#accountCard`, Workspace settings → `/settings.html` as real links |
| 10 | Mobile users trapped (sidebar hidden <900px, no menu) | Hamburger nav bar on members / weekly-digest / case-detail (dashboard already had the tab bar) |
| 11 | Member search client-side only (only the loaded slice) | Server-side `ilike` search in the members API + debounced client wiring |
| 12 | "Lifetime value" column shows subscription amount, not LTV | Renamed honestly to **"Subscription value"** |
| 13 | Digest page injects stored narrative via innerHTML | Rendered with `textContent` / DOM builders — no sink |
| 14 | Digest copy claims "scheduled … can be added later" | Now states digests are generated automatically (they are — nightly cron) |
| 15 | Changelog page broken | **Partially wrong**: the page did read `/api/changelog` — it was empty because nothing seeded the table. `0004` seeds the first three entries |
| 16 | No STOP handling for SMS | `POST /api/webhooks/sms-inbound`: Twilio signature-verified (HMAC-SHA1, timing-safe), STOP → cross-org suppression by phone, START → removal, 204s, rate-limit exempt |
| 17 | Twilio env vars undocumented | `.env.example` + README (with TRAI/DLT caution) |
| 18 | Only dashboard refreshes expired sessions | Shared `api()` wrapper (refresh + one retry) on members, digest, case-detail |
| 20 | Hard-coded Supabase defaults are silent | Loud production warning when env vars are missing |
| 21 | Alert webhook URL accepts `http://localhost` (SSRF) | `isPublicHttpUrl` guard: loopback / RFC1918 / link-local / metadata / `.local` / non-HTTP rejected |
| 23 | Org deletion audit row dies in the cascade | FK-free `deletion_log` insert **before** the cascade |
| 24 | No lockfile | `package-lock.json` committed; CI and docs now use `npm ci` |
| 25 | "Cancel anytime" guarantee is false during pilot | "Free 14-day pilot · no card required" |
| 26 | Public site demos show $ (product is ₹) | All demo figures converted to ₹ |
| 34 | No way to replay a failed webhook | `POST /api/webhooks/replay` (owner/admin, audit-logged, uses the stored payload) |
| 35 | Approving parked cases one-by-one is unusable | `POST /api/recovery/bulk-approve` (owner/admin, ≤100 cases, per-case failure isolation) + dashboard "Approve all" |
| 39 | money() divides JPY-style currencies by 100 | Zero-decimal currency list on the members page (server parity) |

### Already tracked / prior batches (second opinion re-raised them)

- **#19 RLS** — real and the biggest remaining risk. `0000` documents the
  gap; enabling RLS with per-org policies is a **user action** (Supabase
  dashboard; the pilot's single-workspace posture makes it survivable today,
  it does not survive a second workspace).
- **#36 schema.ts → real_ naming drift** — cosmetic; tracked, low priority.
- **#29–33** (monitors, alerts, error budgets) — ops hardening beyond
  pilot scope; the audit-log + webhook retention + replay tooling from
  batches 3–4 are the groundwork.

### Not code (unchanged human actions)

Supabase RLS + JWT secret rotation · Resend webhook re-save after domain
changes · Razorpay keys re-save under the new env names · Upstash Redis
provisioning (or the in-memory limiter stays per-instance) · TRAI/DLT
review before SMS goes live · MFA on Supabase/Neon/Vercel/Razorpay ·
counsel sign-off on recovery-message language.

### Batch-4 verification

- `node --check` across all server modules: clean.
- Inline scripts of every touched page parse (`new Function`).
- `npm test` → **181/181**: adds webhook 500-on-txn-failure, refund
  reversal (params + least-capped SQL), subscription reconciliation on
  link-payment recovery, resend 409, real YTD day math, server-side search
  params, bulk-approve (403 member / owner happy path with 2 emails),
  replay 400/404, SMS inbound (bad signature 403, signed STOP
  suppression-by-phone SQL, signed START removal, unconfigured 503),
  SSRF destinations, deletion-log-before-cascade, migration inventory,
  lockfile + `npm ci`, Twilio docs, and 14 frontend source checks.
- The suite caught **one real bug** this batch: `send-note`'s error
  whitelist dropped the new 409, turning it into a 500.
