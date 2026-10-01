# Revessent — Audit Response & Fix Checklist

Response to the full audit (items #1–#71 + ADD lists). Status legend:

- ✅ **FIXED** — patched in this pass (see linked file)
- 🔧 **ALREADY OK** — the audit finding was stale/incorrect for the current code; evidence noted
- ⚠️ **NEEDS LIVE VERIFICATION** — depends on your Neon / Supabase / Razorpay settings; SQL or steps provided
- 📋 **DEFERRED** — real, but scoped to the next pass (tracked at the bottom)

---

## SQL TO RUN IN NEON (once, before deploying this branch)

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
| 5 | Sender email spoofing | ✅ FIXED (blocklist) | `server/settings.js` rejects `@revessent.com`, `@resend.dev`, platform domains. Full fix = per-tenant Resend domain verification — 📋 deferred. |
| 6 | "Read-only" claim vs full Key Secret | ⚠️ PARTIAL / 📋 | Razorpay keys can't be scoped; copy on the landing page should stop saying "read-only". Keys ARE stored encrypted (`ENCRYPTION_KEY`). Verify what your key type can do; OAuth/Partner is the real fix (deferred). |
| 7 | Webhook secret plaintext; no key rotation | ⚠️ PARTIAL | Razorpay Key Secret is encrypted; the webhook secret is not (it must be HMAC-checked on every event). Key versioning/rotation: 📋 deferred. **Back up `ENCRYPTION_KEY`** — losing it bricks saved keys. |
| 8 | `rejectUnauthorized:false` | 🔧 ACCEPTED RISK | Standard node-postgres + Neon configuration (Neon's chain isn't in the trust store; TLS still encrypts). Alternative: Neon serverless driver — 📋 deferred. |
| 9 | No security headers | ✅ FIXED | `vercel.json` now sets HSTS, CSP, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy. CSP allows `unsafe-inline` (inline-script pages) but locks connect/img/frame/object sources. |
| 10 | No rate limiting | ✅ PARTIAL | The single router (`api/[...route].js`) now enforces an in-memory sliding window: 30 writes/min/IP/route; webhook + cron are exempt (they auth with secrets). Works per warm instance — a durable limit (Upstash/Vercel KV) is 📋 deferred; swap point is `rateLimited()` in the router. |
| 11 | Gemini key in URL | ✅ FIXED | Both `send-note.js` and `send-sms.js` now send `x-goog-api-key` header; no key in any URL. |
| 12 | Prompt injection / no output guardrails | ✅ MITIGATED | Prompts now carry hard rules: never offer discounts/refunds, never include links, never promise reversal, never request card/OTP/password. Full sandboxing: 📋 deferred. |
| 13 | Root files downloadable | ✅ FIXED | Stale root `settings.js` / `dashboard-data.js` deleted; `.vercelignore` excludes `schema.ts`, docs, `.env.example`, `tests/`. |
| 14 | Org UUID in webhook URL; raw payloads kept forever | ⚠️ ACCEPTED / 📋 | UUID-in-URL is standard practice (Stripe does `?org=` too — it's a routing hint, not the auth; the HMAC secret is). Payload retention policy: 📋 deferred (privacy page notes it). |
| 15 | App-level tenant isolation only | ⚠️ DEFERRED (RLS) | Every query now org-scoped or org-checked after fetch (verified in tests). Postgres RLS as defense-in-depth: 📋 deferred. |
| 16 | No MFA / audit log / session mgmt | ✅ PARTIAL | Audit log implemented: `server/_lib/audit.js` records api_key.created/revoked, razorpay.connected, settings.updated, case.retry, note.sent into `audit_log` (SQL above; best-effort — a missing table never breaks the action). MFA: enable in Supabase. Session mgmt: 📋 deferred. |

## Money path

| # | Finding | Status | Notes |
|---|---|---|---|
| 17 | Webhook auto-registration may fail | ⚠️ VERIFY | `server/razorpay/connect.js` registers via Razorpay's Webhooks API using your Key ID/Secret. Verify in your dashboard that the webhook appears; manual setup steps are on the ADD list if it fails. |
| 18 | Signature hashes re-serialized body | 🔧 ALREADY OK | The handler HMACs the **raw request bytes** (`readRawBody` → `createHmac().update(buffer)`), not re-serialized JSON. Verified by tests (bad signature → 400, good → 200). |
| 19 | Ignores `x-razorpay-event-id` | ✅ FIXED | Header is now the primary dedupe id; payload fingerprint is the fallback. |
| 20 | 200 on processing failure | ✅ FIXED | Processing failures now return **500** so Razorpay retries, and previously-errored events are **reprocessed** (only cleanly-processed ones dedupe). |
| 21 | `status = any($n::text[])` vs enum | ⚠️ VERIFY | `schema.ts` defines `status` as `text`, which is safe. Run `select data_type from information_schema.columns where table_name='recovery_cases' and column_name='status';` — if it says `USER-DEFINED`, run `ALTER TABLE recovery_cases ALTER COLUMN status TYPE text;` |
| 22 | `recovery_attributions` never written | ✅ FIXED | Recovery (payment.captured on an open case) now inserts a ledger row, guarded against double-counting. Dashboard/export/billing all read it. |
| 23 | `stripe_subscriptions` never written | ✅ PARTIAL | Light sync: every payment event upserts the subscription (captured → `active`, failed → `past_due`) via `upsertSubscriptionFromPayment` (`on conflict (organization_id, stripe_subscription_id)`). Full historical backfill: 📋 deferred (ADD list). |
| 24 | Only 2 event types handled | 📋 DEFERRED | `subscription.*`/`invoice.*`/refund/dispute handlers on the ADD list. |
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
| 37 | No Resend webhooks / suppression / SPF-DKIM flow | ✅ PARTIAL | App-side suppression implemented: `/api/unsubscribe` writes to `suppression_list` (unique per org+lower(email)) and send-note checks it before every send (409 if suppressed — test-covered). Resend delivery webhooks (bounces/complaints) + SPF/DKIM on a custom domain: 📋 deferred. |
| 38 | Approval / trust levels not enforced | ✅ FIXED | `organizations.trust_level` (default `approval_required`) now gates the cron: while approval is required, the scheduler NEVER emails a customer — it parks the case as `awaiting_approval` + logs an activity for a human. Manual owner/admin sends are unaffected (that click is the approval). Bulk-approve UI: 📋 deferred. |
| 39 | Phone as name; 2-decimal currencies | ✅ PARTIAL | Phone-like strings (`+91 98765 43210`) are blanked on member insert/update (`isPhoneLike`) — test-covered. Zero-decimal vs 2-decimal currency handling (JPY-style edge): 📋 deferred. |

## Database

| # | Finding | Status | Notes |
|---|---|---|---|
| 40 | schema.ts drift | ✅ FIXED | `users.supabase_user_id`, `recovery_notes.updated_at`, nullable `slug` added; ALTER SQL above. |
| 41 | No migrations/seed | 📋 DEFERRED | SQL blocks in this file + PR descriptions are the interim process. |
| 42 | Missing constraints/indexes | ✅ FIXED | SQL above: unique `supabase_user_id`, unique `idempotency_key`, `(org,status)`, `(org,created_at)`, `lower(email)`. |
| 43 | `stripe_*` naming; dead Better Auth tables | 📋 DEFERRED | Renaming to `payment_*` is a coordinated migration — ADD "Later" list. |
| 44 | No team table | 📋 DEFERRED | Single-owner model today; roles exist on `users`. |
| 45 | 12 pools risk connection exhaustion | ✅ FIXED | Every `new Pool()` is `max: 1` (serverless-safe with Neon). README recommends the pooled connection string. |
| 46 | Dashboard queries serial; wrong range; closed-status constant | ✅ FIXED | All 8 metrics now run via one `Promise.all`; recovery rate is scoped to the selected range (7/30/90d) with a ±range prior window; the lying `OPEN_CASE_STATUSES` constant renamed `CLOSED_CASE_STATUSES_SQL` (and the two call sites the rename had missed — caught by the new tests); the invented "industry average" is gone. |

## Fake UI & promises

| # | Finding | Status | Notes |
|---|---|---|---|
| 47 | Lead forms go nowhere | ✅ FIXED | New public `POST /api/leads` (validated email, source tag, rate-limited) writes to a `leads` table (SQL above). All three landing-page forms submit for real — the success chip only appears after the server confirms the save — and the sign-in card's "Request pilot access" captures the typed email too. |
| 48 | Fake "Connect Razorpay" | ✅ FIXED | The dashboard connect card no longer fakes a connection — any submit routes to `/settings.html`, where the real (encrypted, webhook-registering) connect flow lives. Button copy says "Connect in Settings". |
| 49 | Upgrade toast; pilot card; refund guarantee | ✅ PARTIAL | Onboard sets a real 14-day pilot window (`pilot_started_at`/`pilot_ends_at`, SQL above); the dashboard card counts actual days from the org's dates (server sends them). Refund-guarantee/upgrade copy: 📋 deferred with #50/#71. |
| 50 | Pricing page oversells | 📋 DEFERRED | Copy/feature honesty pass needed (Slack alerts, API keys, CSV export, changelog DO exist now). |
| 51 | $ vs ₹; invented benchmarks | ✅ PARTIAL | Dashboard money is now formatted in the workspace currency (`Intl.NumberFormat`, INR default — the product is Razorpay/India-first) instead of hard-coded `$`; the server sends `currency` from the latest case; the invented benchmark was removed with #46. Full localisation (per-viewer locale/currency choice): 📋 deferred. |
| 52 | Sign out / profile email / avatar hard-coded | ✅ FIXED | Sign-out wired (`supabase.auth.signOut()` → login); profile email + initials from the session. |
| 53 | Silent $0 on API failure | ✅ FIXED | 401 → redirect to login; other failures now show a persistent, dismissible error banner (not just a vanishing toast) above the empty state. |
| 54 | Digest page dead; legal 404 | ✅ PARTIAL | `terms.html` + `privacy.html` published and linked (DRAFT — review counsel). Digest generation: 📋 deferred. |

## Auth & accounts

| # | Finding | Status | Notes |
|---|---|---|---|
| 55 | Signup assumes session | ✅ FIXED | No-session signup now shows "check your inbox and confirm your email" instead of a fake redirect. |
| 56 | Forgot-password dead-end | ✅ FIXED | `reset-password.html` exists (audit #56): the reset email redirects here (explicit `redirectTo`), a recovery session is required, password + confirm validated, then sent to Supabase `updateUser`. Still ⚠️ VERIFY the Supabase email template doesn't override the redirect. |
| 57 | Fire-and-forget onboarding sync | ✅ FIXED | `login.html` now awaits the sync before redirecting. |
| 58 | `onboarding.html` orphaned | 📋 DEFERRED | Delete or wire it. |
| 59 | Token read once; no refresh | ⚠️ PARTIAL | supabase-js refreshes automatically while the page is open; long-idle tabs may still 401 → now redirected to login (see #53). |
| 60 | No email/password change, delete, export | 📋 DEFERRED | CSV exports cover business data; account self-management: ADD list. |

## Frontend / ops

| # | Finding | Status | Notes |
|---|---|---|---|
| 61 | Monolithic HTML files | 📋 DEFERRED | Deliberate no-build choice; revisit if the team grows. |
| 62 | Cloudflare junk scripts; heavy visuals | ✅ FIXED (junk) | CF challenge-platform + email-decode scripts stripped from dashboard/weekly-digest. Visual weight on low-end devices: 📋 deferred. |
| 63 | Hash routes, no OG/sitemap/robots | ✅ PARTIAL | Landing page now has canonical + Open Graph + Twitter card meta. Sitemap/robots + hash-route cleanup: 📋 deferred. |
| 64 | No pagination/search; member cap | ⚠️ PARTIAL | Search exists on members page; pagination + >100 handling: 📋 deferred. |
| 65 | Two stacks mashed; env docs wrong; KEY_ vs ENCRYPTION_ | ✅ FIXED | `.env.example` rewritten for the real stack (Neon/Supabase/Razorpay/Gemini/Resend + ENCRYPTION_KEY/CRON_SECRET/PUBLIC_APP_URL); old Better Auth/Stripe/Next values gone. README's table is the source of truth. Dead `onboarding.html` still to delete (see #58). |
| 66 | Copy-pasted auth; hardcoded Supabase creds | ✅ PARTIAL | Supabase URL/key now env-overridable in all 18 server modules (fallbacks keep current deploys working). Local-JWT verification + shared auth module: 📋 deferred (single router makes the refactor easier). |
| 67 | No tests/CI/README/gitignore | ✅ PARTIAL | Offline suite extended to **94 checks** (leads, unsubscribe token round-trip, suppression 409, rate-limit 429 + exemptions, UPI decline mapping, subscription upsert, phone-name blanking, cron approval gate + stale sweep, dashboard currency/pilot) + `/api/health` liveness endpoint + README/.gitignore/.vercelignore. CI, lint, TS: 📋 deferred. |
| 68 | **23 functions > Hobby's 12 cap — deploys fail** | ✅ FIXED | **All endpoints consolidated into ONE function** (`api/[...route].js` → `server/*`). This was silently breaking every deployment of this branch. Note: Hobby is also non-commercial — Pro before charging customers. |
| 69 | No legal pages | ✅ PARTIAL | Draft Terms + Privacy published & linked (review with counsel; India DPDP + GDPR framed). |
| 70 | Messaging compliance (unsubscribe, TRAI/DLT, RBI) | 📋 DEFERRED | Do not enable SMS/auto-debit until reviewed. |
| 71 | Honest-copy pass | 📋 DEFERRED | See #6/#49/#50. |

## ADD list — prioritized next

1. **Durable rate limiting (Upstash/Vercel KV) + Sentry + webhook replay UI (#10).**
2. **Full subscription/invoice backfill (#23)** — makes members/MRR real; the live upsert already keeps new events current.
3. **Resend delivery webhooks (bounce/complaint → suppression) + SPF/DKIM domain flow (#37).**
4. **Bulk-approve UI for `awaiting_approval` cases (#38) + audit-log viewer.**
5. **Account self-management (#60) + onboarding.html deletion (#58).**
6. **CI (run the suite on every PR) + migrations tooling (#41).**
7. Digest generation, sitemap/robots, per-tenant domain verification, RLS, honest-copy pass (#6/#49/#50/#71).
8. Then the "Next"/"Later" product items (smart timing, more processors, billing for Revessent itself).

## Verification

- `node --check` across all server modules + router: clean.
- `npm test` → **94/94** covering: router dispatch, onboard token security
  (401/403/token-wins), role gates, sender blocklist, webhook signature/
  dedupe/500-retry/reprocess, attribution ledger, alert wiring, retry guards
  (not-lost on infra failure), API-key lifecycle, CSV escaping — plus batch-2:
  lead capture, unsubscribe token round-trip + suppression upsert, send-note
  suppression 409, unsubscribe footer/plain-text/reply-to, in-router rate
  limit (429 + read/webhook exemptions), UPI decline mapping
  (per-txn-limit → insufficient_funds, mandate/NACH → no-auto-retry),
  subscription upsert (active/past_due), phone-like name blanking, cron auth +
  approval gate + stale sweep + trusted-org email path, and dashboard
  currency/pilot-window fields (including the INR default and null pilot).
  The dashboard tests also caught two real regressions before they shipped
  (undefined `cleanString` in the webhook, undefined `OPEN_CASE_STATUSES_SQL`
  in two dashboard queries).
- `vercel.json` / `package.json` parse; function count = 1 (Hobby-safe).
