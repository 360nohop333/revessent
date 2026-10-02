-- Batch-4 (second-opinion audit): refund-aware attribution, SMS STOP
-- suppression, changelog seed entries.

-- 2nd-opinion #4: refunds must reverse recovery attribution (net revenue).
ALTER TABLE recovery_attributions ADD COLUMN IF NOT EXISTS refunded_cents integer NOT NULL DEFAULT 0;

-- 2nd-opinion #16: SMS STOP/START suppression is keyed by phone.
ALTER TABLE suppression_list ADD COLUMN IF NOT EXISTS phone text;
CREATE INDEX IF NOT EXISTS suppression_list_org_phone_idx ON suppression_list(organization_id, phone);

-- 2nd-opinion #15: seed the changelog so the public page reflects reality.
INSERT INTO changelog_entries (title, body, published_at)
SELECT * FROM (VALUES
  ('Recovery intelligence, hardened',
   'Smart retry scheduling (payday-aware for insufficient funds, no auto-retry for UPI mandate failures), recovery attribution ledger, Slack/Discord alerts, API keys, CSV exports, referrals and the weekly forensics digest.',
   now() - interval ''31 days''),
  ('Trust by construction',
   'Every workspace now starts in approval-required mode: the scheduler never emails your customers without a human click. One-click unsubscribe with automatic suppression, audit logging of every privileged action, and encrypted Razorpay credentials.',
   now() - interval ''9 days''),
  ('The dashboard tells the truth',
   'Real pilot countdown, workspace-currency amounts (₹ by default), member search and pagination, bounce/complaint auto-suppression, and a honest pricing page — billing switches on at launch.',
   now() - interval ''1 day'')
) AS seed(title, body, published_at)
WHERE NOT EXISTS (SELECT 1 FROM changelog_entries);
