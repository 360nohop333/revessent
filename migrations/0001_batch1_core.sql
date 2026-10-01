-- Batch-1 core fixes (see AUDIT.md)
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
