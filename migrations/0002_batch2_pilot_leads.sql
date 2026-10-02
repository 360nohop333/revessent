-- Batch-2: pilot window, trust levels, leads, suppression, audit log (see AUDIT.md)

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
