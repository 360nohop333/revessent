-- Batch-3: the cron's weekly digest upsert needs this unique index
-- (audit #54). Safe if it already exists.

-- If the table itself is missing entirely (fresh-ish DB), create it:
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
