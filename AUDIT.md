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
```

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
| 10 | No rate limiting | 📋 DEFERRED | Needs durable storage (Upstash Redis / Vercel KV) to work across instances — in-memory limits are fiction on serverless. |
| 11 | Gemini key in URL | ✅ FIXED | Both `send-note.js` and `send-sms.js` now send `x-goog-api-key` header; no key in any URL. |
| 12 | Prompt injection / no output guardrails | ✅ MITIGATED | Prompts now carry hard rules: never offer discounts/refunds, never include links, never promise reversal, never request card/OTP/password. Full sandboxing: 📋 deferred. |
| 13 | Root files downloadable | ✅ FIXED | Stale root `settings.js` / `dashboard-data.js` deleted; `.vercelignore` excludes `schema.ts`, docs, `.env.example`, `tests/`. |
| 14 | Org UUID in webhook URL; raw payloads kept forever | ⚠️ ACCEPTED / 📋 | UUID-in-URL is standard practice (Stripe does `?org=` too — it's a routing hint, not the auth; the HMAC secret is). Payload retention policy: 📋 deferred (privacy page notes it). |
| 15 | App-level tenant isolation only | ⚠️ DEFERRED (RLS) | Every query now org-scoped or org-checked after fetch (verified in tests). Postgres RLS as defense-in-depth: 📋 deferred. |
| 16 | No MFA / audit log / session mgmt | 📋 DEFERRED | Supabase supports MFA at the auth layer; enable it there. Audit log is on the ADD list. |

## Money path

| # | Finding | Status | Notes |
|---|---|---|---|
| 17 | Webhook auto-registration may fail | ⚠️ VERIFY | `server/razorpay/connect.js` registers via Razorpay's Webhooks API using your Key ID/Secret. Verify in your dashboard that the webhook appears; manual setup steps are on the ADD list if it fails. |
| 18 | Signature hashes re-serialized body | 🔧 ALREADY OK | The handler HMACs the **raw request bytes** (`readRawBody` → `createHmac().update(buffer)`), not re-serialized JSON. Verified by tests (bad signature → 400, good → 200). |
| 19 | Ignores `x-razorpay-event-id` | ✅ FIXED | Header is now the primary dedupe id; payload fingerprint is the fallback. |
| 20 | 200 on processing failure | ✅ FIXED | Processing failures now return **500** so Razorpay retries, and previously-errored events are **reprocessed** (only cleanly-processed ones dedupe). |
| 21 | `status = any($n::text[])` vs enum | ⚠️ VERIFY | `schema.ts` defines `status` as `text`, which is safe. Run `select data_type from information_schema.columns where table_name='recovery_cases' and column_name='status';` — if it says `USER-DEFINED`, run `ALTER TABLE recovery_cases ALTER COLUMN status TYPE text;` |
| 22 | `recovery_attributions` never written | ✅ FIXED | Recovery (payment.captured on an open case) now inserts a ledger row, guarded against double-counting. Dashboard/export/billing all read it. |
| 23 | `stripe_subscriptions` never written | 📋 DEFERRED | Subscription/invoice sync + history backfill is the next money-path item. |
| 24 | Only 2 event types handled | 📋 DEFERRED | `subscription.*`/`invoice.*`/refund/dispute handlers on the ADD list. |
| 25 | One case per failed payment | 🔧 PARTLY OK | Same payment id → one case (DB-level `on conflict (stripe_invoice_id)`). Separate failed charges create separate cases (arguably correct). No "3 OTP mistypes = 3 cases" for the same payment. |
| 26 | Hard declines retried; no UPI reasons | 🔧 PARTLY OK | Non-retryable codes (expired/invalid/lost/stolen/pickup) skip auto-retry and go to `awaiting_approval` with an email instead. UPI/netbanking/wallet-specific codes: 📋 deferred. |
| 27 | Guest checkout → NULL member crash | 🔧 ALREADY OK | `findOrCreateMember` creates a member from the payment email/customer id; verified in code and tests. |
| 28 | No scheduler | 🔧 STALE | `server/cron/process-recovery-queue.js` + `vercel.json` cron (daily 03:30 UTC — Hobby's max) already process due cases by `next_retry_at`. It was hourly-incompatible with Hobby, now fixed. |
| 29 | Order + link both created; notify bypasses voice | 📋 DEFERRED | Retry creates a payment link; Razorpay's own notify behavior needs product decisions (drop `notify`, show link in UI). |
| 30 | No cap on successful retries | 🔧 ALREADY OK | Only cases in open statuses can be retried (`ELIGIBLE_STATUSES`); a recovered case → 400 "not eligible". |
| 31 | API error can condemn good customers | ✅ FIXED | "Lost" is only set when Razorpay **responded** with an error; network/infra failures leave the case open for the next run. |
| 32 | Stuck pending attempt blocks retries; no unique index | ✅ FIXED (index) / 📋 (stale sweep) | Unique index SQL above makes the 409 race protection real. Stale-pending cleanup: deferred. |
| 33 | Retries logged as `note_sent`; link not shown | 📋 DEFERRED | Activity-type naming + surfacing the link in the dashboard. |
| 34 | Re-saving keys registers duplicate webhooks | ⚠️ VERIFY / 📋 | Check `connect.js` dedupe behavior against your account (Razorpay rejects exact-duplicate webhooks, but changed secrets create new ones). Cleanup + disconnect: ADD list. |
| 35 | Email template gaps (CTA, unsubscribe, plain-text, autoSend) | 📋 DEFERRED | Needs the template/unsubscribe work on the ADD list. |
| 36 | `gemini-2.0-flash` retired | ✅ FIXED | `GEMINI_MODEL` env var, default `gemini-2.5-flash`; document in README/.env.example. |
| 37 | No Resend webhooks / suppression / SPF-DKIM flow | 📋 DEFERRED | On the ADD list. |
| 38 | Approval / trust levels not enforced | 📋 DEFERRED | `awaiting_approval` IS set for non-retryable declines; enforcement + bulk approve + trust levels: ADD list. |
| 39 | Phone as name; 2-decimal currencies | 📋 DEFERRED | Real issues for INR-centric data; on the ADD list. |

## Database

| # | Finding | Status | Notes |
|---|---|---|---|
| 40 | schema.ts drift | ✅ FIXED | `users.supabase_user_id`, `recovery_notes.updated_at`, nullable `slug` added; ALTER SQL above. |
| 41 | No migrations/seed | 📋 DEFERRED | SQL blocks in this file + PR descriptions are the interim process. |
| 42 | Missing constraints/indexes | ✅ FIXED | SQL above: unique `supabase_user_id`, unique `idempotency_key`, `(org,status)`, `(org,created_at)`, `lower(email)`. |
| 43 | `stripe_*` naming; dead Better Auth tables | 📋 DEFERRED | Renaming to `payment_*` is a coordinated migration — ADD "Later" list. |
| 44 | No team table | 📋 DEFERRED | Single-owner model today; roles exist on `users`. |
| 45 | 12 pools risk connection exhaustion | ✅ FIXED | Every `new Pool()` is `max: 1` (serverless-safe with Neon). README recommends the pooled connection string. |
| 46 | Dashboard queries serial; wrong range; closed-status constant | 📋 DEFERRED | Perf/correctness polish in the dashboard endpoint. |

## Fake UI & promises

| # | Finding | Status | Notes |
|---|---|---|---|
| 47 | Lead forms go nowhere | 📋 DEFERRED | Needs a lead-capture endpoint (mind the function budget — now safe with the single router). |
| 48 | Fake "Connect Razorpay" | 🔧 STALE | Settings page really saves keys (encrypted) and registers the webhook; the dashboard "connect" marketing card is cosmetic — 📋 to wire/remove. |
| 49 | Upgrade toast; pilot card; refund guarantee | 📋 DEFERRED | No billing exists; the guarantee copy should be softened until it's backed by the attribution ledger (which now records data). |
| 50 | Pricing page oversells | 📋 DEFERRED | Copy/feature honesty pass needed (Slack alerts, API keys, CSV export, changelog DO exist now). |
| 51 | $ vs ₹; invented benchmarks | 📋 DEFERRED | Localization pass. |
| 52 | Sign out / profile email / avatar hard-coded | ✅ FIXED | Sign-out wired (`supabase.auth.signOut()` → login); profile email + initials from the session. |
| 53 | Silent $0 on API failure | ✅ FIXED | 401 → redirect to login; other failures keep the toast + empty state (an explicit error banner is on the ADD list). |
| 54 | Digest page dead; legal 404 | ✅ PARTIAL | `terms.html` + `privacy.html` published and linked (DRAFT — review counsel). Digest generation: 📋 deferred. |

## Auth & accounts

| # | Finding | Status | Notes |
|---|---|---|---|
| 55 | Signup assumes session | ✅ FIXED | No-session signup now shows "check your inbox and confirm your email" instead of a fake redirect. |
| 56 | Forgot-password dead-end | ⚠️ VERIFY / 📋 | A handler exists (calls Supabase reset); verify the email template's redirect URL. Dedicated reset page: ADD list. |
| 57 | Fire-and-forget onboarding sync | ✅ FIXED | `login.html` now awaits the sync before redirecting. |
| 58 | `onboarding.html` orphaned | 📋 DEFERRED | Delete or wire it. |
| 59 | Token read once; no refresh | ⚠️ PARTIAL | supabase-js refreshes automatically while the page is open; long-idle tabs may still 401 → now redirected to login (see #53). |
| 60 | No email/password change, delete, export | 📋 DEFERRED | CSV exports cover business data; account self-management: ADD list. |

## Frontend / ops

| # | Finding | Status | Notes |
|---|---|---|---|
| 61 | Monolithic HTML files | 📋 DEFERRED | Deliberate no-build choice; revisit if the team grows. |
| 62 | Cloudflare junk scripts; heavy visuals | ✅ FIXED (junk) | CF challenge-platform + email-decode scripts stripped from dashboard/weekly-digest. Visual weight on low-end devices: 📋 deferred. |
| 63 | Hash routes, no OG/sitemap/robots | 📋 DEFERRED | SEO pass on the ADD list. |
| 64 | No pagination/search; member cap | ⚠️ PARTIAL | Search exists on members page; pagination + >100 handling: 📋 deferred. |
| 65 | Two stacks mashed; env docs wrong; KEY_ vs ENCRYPTION_ | 📋 DEFERRED | `.env.example` still describes the old stack — use README's table as truth today. |
| 66 | Copy-pasted auth; hardcoded Supabase creds | ✅ PARTIAL | Supabase URL/key now env-overridable in all 18 server modules (fallbacks keep current deploys working). Local-JWT verification + shared auth module: 📋 deferred (single router makes the refactor easier). |
| 67 | No tests/CI/README/gitignore | ✅ PARTIAL | Offline suite (`tests/suite.test.js`, 67 checks) + README + `.gitignore` + `.vercelignore` committed. CI, lint, TS: 📋 deferred. |
| 68 | **23 functions > Hobby's 12 cap — deploys fail** | ✅ FIXED | **All endpoints consolidated into ONE function** (`api/[...route].js` → `server/*`). This was silently breaking every deployment of this branch. Note: Hobby is also non-commercial — Pro before charging customers. |
| 69 | No legal pages | ✅ PARTIAL | Draft Terms + Privacy published & linked (review with counsel; India DPDP + GDPR framed). |
| 70 | Messaging compliance (unsubscribe, TRAI/DLT, RBI) | 📋 DEFERRED | Do not enable SMS/auto-debit until reviewed. |
| 71 | Honest-copy pass | 📋 DEFERRED | See #6/#49/#50. |

## ADD list — prioritized next

1. **Subscription/invoice sync + backfill (#23)** — makes members/MRR real.
2. **Approval flow + trust levels + audit log (#16/#38).**
3. **Email template with CTA/unsubscribe/plain-text + Resend webhooks (#35/#37).**
4. **Rate limiting (Upstash) + Sentry + webhook replay UI (#10).**
5. **Lead capture + reset-password page + account self-management.**
6. **CI (run the suite on every PR) + migrations tooling.**
7. Digest generation, SEO/OG pass, per-tenant domain verification, RLS.
8. Then the "Next"/"Later" product items (smart timing, UPI reasons, more processors, billing for Revessent itself).

## Verification

- `node --check` across all 23 server modules + router: clean.
- `npm test` → **67/67** covering: router dispatch, onboard token security
  (401/403/token-wins), role gates, sender blocklist, webhook signature/
  dedupe/500-retry/reprocess, attribution ledger, alert wiring, retry guards
  (not-lost on infra failure), API-key lifecycle, CSV escaping, and
  source-level assertions for every fix above.
- `vercel.json` / `package.json` parse; function count = 1 (Hobby-safe).
