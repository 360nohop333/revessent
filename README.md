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
| `ENCRYPTION_KEY` | yes | 64 hex chars — encrypts Razorpay secrets (`openssl rand -hex 32`) |
| `CRON_SECRET` | yes | shared secret the daily cron presents |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | recommended | fall back to built-in defaults if unset |
| `GEMINI_API_KEY` | optional | enables AI email/SMS drafting |
| `GEMINI_MODEL` | optional | defaults to `gemini-2.5-flash` |
| `RESEND_API_KEY` | optional | enables email sending |

## Database

`schema.ts` documents the shape; apply changes by running SQL in the Neon
SQL editor (see `AUDIT.md` for the current migration block). There is no
migration tool wired up yet.

## Testing

```
npm install   # installs pg (tests monkeypatch it — nothing touches a real DB)
npm test
```

## Cron

`vercel.json` runs `/api/cron/process-recovery-queue` daily at 03:30 UTC
(09:00 IST) — the Hobby-plan maximum. On Pro, tighten to `0 * * * *`.
