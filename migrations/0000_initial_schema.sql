-- 0000: FULL base schema — a brand-new Neon database bootstraps entirely from
-- this file (second-opinion audit P0-1: the runner used to start with ALTERs
-- against tables nothing had created).
--
-- Mirrors the CURRENT production shape (including the batch-1/2/3 columns), so
-- migrations 0001–0003 are idempotent no-ops on a fresh DB and still apply to
-- an existing one. Status columns are TEXT, not enums — see audit #21 (the
-- code compares statuses as text; USER-DEFINED enums broke `= any($n)`).
--
-- Column-by-column source of truth: schema.ts.

-- ─── organizations ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text,                                        -- audit #40: nullable
  plan text NOT NULL DEFAULT 'ember',
  trust_level text NOT NULL DEFAULT 'approval_required',
  pilot_started_at timestamptz,
  pilot_ends_at timestamptz,
  stripe_customer_id text,
  stripe_price_id text,
  stripe_subscription_id text,
  subscription_status text,
  member_count integer NOT NULL DEFAULT 0,
  alert_webhook_url text,
  alert_min_amount_cents integer NOT NULL DEFAULT 0,
  referral_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_idx ON organizations(slug);
CREATE UNIQUE INDEX IF NOT EXISTS organizations_referral_code_idx ON organizations(referral_code);

-- ─── users ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text,
  password_hash text,                               -- legacy Better Auth; unused
  role text NOT NULL DEFAULT 'member',
  supabase_user_id text,                            -- audit #40
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_supabase_user_id_idx ON users(supabase_user_id);
CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users(lower(email));

-- ─── legacy Better Auth tables (kept so existing DBs match; code never reads) ─
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ─── payment connections (Razorpay; stripe_* names are legacy — audit #43) ──
CREATE TABLE IF NOT EXISTS stripe_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_account_id text NOT NULL,                  -- Razorpay Key ID
  encrypted_restricted_key text NOT NULL,           -- AES-256-GCM ciphertext
  key_iv text NOT NULL,
  key_tag text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  webhook_endpoint_id text,
  webhook_secret text,                              -- enc:v1:… (audit #7)
  connected_at timestamptz,
  backfill_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stripe_connections_org_idx ON stripe_connections(organization_id);

-- ─── members (Razorpay customers) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stripe_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_customer_id text,
  email text,
  name text,
  phone text,                                      -- SMS channel (Razorpay contact)
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stripe_members_org_idx ON stripe_members(organization_id);
CREATE INDEX IF NOT EXISTS stripe_members_org_customer_idx ON stripe_members(organization_id, stripe_customer_id);

-- ─── subscriptions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stripe_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid REFERENCES stripe_members(id) ON DELETE SET NULL,
  stripe_subscription_id text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  amount_cents integer,
  currency text NOT NULL DEFAULT 'INR',
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS stripe_subscriptions_org_sub_idx
  ON stripe_subscriptions(organization_id, stripe_subscription_id);
CREATE INDEX IF NOT EXISTS stripe_subscriptions_member_idx ON stripe_subscriptions(member_id);

-- ─── webhook events (retained WEBHOOK_RETENTION_DAYS, default 30 — audit #14) ─
CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_event_id text NOT NULL,                    -- Razorpay event id
  event_type text,
  payload jsonb NOT NULL,
  processed_at timestamptz,
  processing_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_stripe_event_id_idx ON webhook_events(stripe_event_id);
CREATE INDEX IF NOT EXISTS webhook_events_org_created_idx ON webhook_events(organization_id, created_at);

-- ─── recovery cases ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recovery_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid REFERENCES stripe_members(id) ON DELETE SET NULL,
  subscription_id uuid REFERENCES stripe_subscriptions(id) ON DELETE SET NULL,
  stripe_invoice_id text,                           -- Razorpay payment id
  stripe_charge_id text,
  status text NOT NULL DEFAULT 'detected',
  decline_code text,
  amount_cents integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'INR',
  next_retry_at timestamptz,
  retry_count integer NOT NULL DEFAULT 0,
  max_retries integer NOT NULL DEFAULT 3,
  recovery_source text,
  recovered_at timestamptz,
  lost_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS recovery_cases_stripe_invoice_idx
  ON recovery_cases(organization_id, stripe_invoice_id);
CREATE INDEX IF NOT EXISTS recovery_cases_org_status_idx ON recovery_cases(organization_id, status);
CREATE INDEX IF NOT EXISTS recovery_cases_member_idx ON recovery_cases(member_id);

-- ─── recovery attempts ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recovery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES recovery_cases(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL DEFAULT 1,
  razorpay_payment_id text,
  status text NOT NULL DEFAULT 'pending',           -- pending | success | failed
  error_code text,
  error_message text,
  idempotency_key text,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS recovery_attempts_idempotency_key_idx
  ON recovery_attempts(idempotency_key);
CREATE INDEX IF NOT EXISTS recovery_attempts_org_case_idx ON recovery_attempts(organization_id, case_id);

-- ─── recovery attributions (the outcome ledger) ──────────────────────────────
CREATE TABLE IF NOT EXISTS recovery_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES recovery_cases(id),
  member_id uuid NOT NULL REFERENCES stripe_members(id),
  source text NOT NULL DEFAULT 'retry',
  amount_cents integer NOT NULL,
  refunded_cents integer NOT NULL DEFAULT 0,        -- audit/2nd-opinion #4
  currency text NOT NULL DEFAULT 'INR',
  recovered_at timestamptz NOT NULL,
  attribution_window_days integer NOT NULL DEFAULT 90,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recovery_attributions_org_idx ON recovery_attributions(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS recovery_attributions_case_idx ON recovery_attributions(case_id);

-- ─── recovery notes ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recovery_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES recovery_cases(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject text,
  body text,
  requires_approval boolean NOT NULL DEFAULT true,
  approved_at timestamptz,
  approved_by_user_id uuid,
  sent_at timestamptz,
  resend_email_id text,
  sms_message text,
  sms_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()     -- audit #40
);
CREATE INDEX IF NOT EXISTS recovery_notes_case_idx ON recovery_notes(case_id);

-- ─── voice profiles ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS voice_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Default',
  brand_name text,
  sender_name text,
  sender_email text,
  tone_description text,
  is_default boolean NOT NULL DEFAULT true,
  sms_enabled boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_profiles_org_idx ON voice_profiles(organization_id);

-- ─── expansion opportunities (schema present; feature deferred) ──────────────
CREATE TABLE IF NOT EXISTS expansion_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES stripe_members(id) ON DELETE CASCADE,
  signal_type text NOT NULL,
  status text NOT NULL DEFAULT 'drafted',
  draft_subject text,
  draft_body text,
  sent_at timestamptz,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expansion_opportunities_org_idx ON expansion_opportunities(organization_id);

-- ─── activity feed ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_feed (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  description text,
  amount_cents integer,
  currency text,
  member_id uuid,
  case_id uuid,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_feed_org_created_idx ON activity_feed(organization_id, created_at);

-- ─── weekly forensics digests (audit #54) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS forensics_digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  week_start_date timestamptz NOT NULL,
  week_end_date timestamptz NOT NULL,
  total_failed integer NOT NULL DEFAULT 0,
  total_recovered integer NOT NULL DEFAULT 0,
  total_lost integer NOT NULL DEFAULT 0,
  recovered_amount_cents bigint NOT NULL DEFAULT 0,
  lost_amount_cents bigint NOT NULL DEFAULT 0,
  top_decline_reasons jsonb,
  ai_narrative_paragraph text,
  sent_at timestamptz,
  resend_email_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS forensics_digests_org_week_idx
  ON forensics_digests(organization_id, week_start_date);

-- ─── API keys (F13) ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key_prefix text NOT NULL,
  key_hash text NOT NULL,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_prefix_idx ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys(organization_id);

-- ─── changelog (F14 — rows inserted by migration/manual SQL, no admin UI) ────
CREATE TABLE IF NOT EXISTS changelog_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ─── referrals (F15) ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_organization_id uuid NOT NULL REFERENCES organizations(id),
  referred_organization_id uuid REFERENCES organizations(id),
  referral_code text NOT NULL,
  signed_up_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals(referrer_organization_id);
CREATE INDEX IF NOT EXISTS referrals_code_idx ON referrals(referral_code);

-- ─── leads (audit #47) ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ─── suppression list (audit #35/#37) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppression_list (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid,
  email text NOT NULL,
  phone text,                                       -- 2nd-opinion #16: SMS STOP
  unsubscribed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppression_list_org_email_idx UNIQUE (organization_id, lower(email))
);
CREATE INDEX IF NOT EXISTS suppression_list_org_phone_idx ON suppression_list(organization_id, phone);

-- ─── audit log (audit #16; best-effort writes) ───────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid,
  action text NOT NULL,
  detail jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_org_idx ON audit_log(organization_id, created_at);

-- ─── deletion log (2nd-opinion #23) ──────────────────────────────────────────
-- Deliberately NO foreign key: the row must SURVIVE the organization cascade,
-- as a durable compliance trail of who deleted what and when.
CREATE TABLE IF NOT EXISTS deletion_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  organization_name text,
  user_email text,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

