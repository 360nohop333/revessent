# Revessent

Revenue-recovery intelligence for subscription businesses (Razorpay-native).
Detects failed payments, retries them at the right moment, drafts recovery
messages in the merchant's voice, and attributes every recovered rupee.

## Stack

Plain Node serverless functions + static HTML pages — no build step.

- **Hosting:** Vercel (single serverless function + daily cron; Hobby-friendly)
- **DB:** Neon PostgreSQL via `pg`
- **Auth:** Supabase (email/password; Bearer access tokens)
- **Payments:** Razorpay (keys + webhook)
- **AI drafting:** Google Gemini (optional) · **Email:** Resend (optional)

## Layout

```
api/[...route].js     ONE serverless function — routes every /api/* URL
server/               endpoint handlers (plain modules, not functions)
*.html                static pages (marketing + app)
schema.ts             Drizzle-style reference schema (documentation)
tests/suite.test.js   offline test suite (mocked DB + network)
```

> Vercel's Hobby plan caps deployments at 12 serverless functions, so all
> endpoints are served through the single catch-all in `api/[...route].js`.
> To add an endpoint: create `server/<path>.js`, then register it in the
> ROUTES map in `api/[...route].js`. Public URLs stay `/api/<path>`.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Neon connection string (prefer the `-pooler` endpoint) |
| `ENCRYPTION_KEY` | yes | 64 hex chars — encrypts Razorpay secrets AND signs unsubscribe tokens (`openssl rand -hex 32`) |
| `CRON_SECRET` | yes | shared secret the daily cron presents |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | recommended | fall back to built-in defaults if unset |
| `GEMINI_API_KEY` | optional | enables AI email/SMS drafting |
| `GEMINI_MODEL` | optional | defaults to `gemini-2.5-flash` |
| `RESEND_API_KEY` | optional | enables email sending |
| `RESEND_FROM_EMAIL` | optional | default sender when no voice profile exists |
| `PUBLIC_APP_URL` | optional | canonical base for unsubscribe links (defaults to the Vercel production URL) |
| `SUPABASE_JWT_SECRET` | optional | verify access tokens locally (no per-request Supabase call) — Supabase → Settings → API → JWT Secret |
| `RESEND_WEBHOOK_SECRET` | optional | enables `/api/webhooks/resend` (bounce/complaint → auto-suppression); from Resend → Webhooks |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | optional | durable cross-instance rate limiting; without them the limiter is per-instance in memory |
| `ENCRYPTION_KEY_OLD` | optional | previous key during rotation — decrypt falls back to it while secrets re-encrypt on save |
| `WEBHOOK_RETENTION_DAYS` | optional | webhook payload retention before the nightly delete (default 30) |

## Database

`schema.ts` documents the shape. Migrations live in `migrations/` and are
applied in order, each in its own transaction, tracked in `_migrations`:

```
DATABASE_URL='postgres://…' npm run migrate
```

(Or copy the SQL blocks from `AUDIT.md` into the Neon SQL editor by hand.)

## Testing

```
npm install   # installs pg (tests monkeypatch it — nothing touches a real DB)
npm test
```

## Cron

`vercel.json` runs `/api/cron/process-recovery-queue` daily at 03:30 UTC
(09:00 IST) — the Hobby-plan maximum. On Pro, tighten to `0 * * * *`.
Each run: sweeps stale pending attempts (>1h), deletes webhook payloads
older than `WEBHOOK_RETENTION_DAYS` (default 30), processes due cases
(respecting the org's trust level — `approval_required` parks cases instead
of emailing customers), and generates/updates the weekly forensics digest
per org.

## Frontend Supabase config

Every page loads `/api/config.js` (served by the single function from env
vars) before its inline fallback, so changing the Supabase project is a
Vercel env-var change, not an HTML edit.

## CI

`.github/workflows/ci.yml` runs the offline test suite and a single-function
guard on every PR and push to `main`.
