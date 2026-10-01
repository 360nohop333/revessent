import {
  sql,
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  jsonb,
  uuid,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ─── Enums ────────────────────────────────────────────────────────────────────

export const planEnum = pgEnum("plan", ["ember", "revessent", "studio"]);

export const trustLevelEnum = pgEnum("trust_level", [
  "approval_required", // pilot mode — every action needs a human thumbs-up
  "notify",            // acts autonomously, notifies after
  "autonomous",        // fully autonomous
]);

export const recoveryCaseStatusEnum = pgEnum("recovery_case_status", [
  "detected",
  "retrying",
  "awaiting_approval",
  "note_sent",
  "checkout_sent",
  "recovered",
  "lost",
  "canceled",
]);

export const recoverySourceEnum = pgEnum("recovery_source", [
  "retry",
  "note",
  "checkout",
  "manual",
]);

export const expansionStatusEnum = pgEnum("expansion_status", [
  "drafted",
  "awaiting_approval",
  "sent",
  "accepted",
  "declined",
  "expired",
]);

export const declineCodeEnum = pgEnum("decline_code", [
  "expired_card",
  "insufficient_funds",
  "card_declined",
  "do_not_honor",
  "invalid_account",
  "lost_card",
  "stolen_card",
  "pickup_card",
  "processing_error",
  "unknown",
]);

// ─── Organizations ─────────────────────────────────────────────────────────────

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug"), // audit #40: nullable — signup never sets one
  plan: planEnum("plan").notNull().default("ember"),
  trustLevel: trustLevelEnum("trust_level").notNull().default("approval_required"),
  pilotStartedAt: timestamp("pilot_started_at"),
  pilotEndsAt: timestamp("pilot_ends_at"),
  stripeCustomerId: text("stripe_customer_id"),       // Revessent's own Stripe customer
  stripePriceId: text("stripe_price_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  subscriptionStatus: text("subscription_status"),
  memberCount: integer("member_count").notNull().default(0),
  // Alerts (F12) — Slack/Discord incoming-webhook URL + minimum recovered
  // amount (cents) below which "payment recovered" alerts stay silent.
  alertWebhookUrl: text("alert_webhook_url"),
  alertMinAmountCents: integer("alert_min_amount_cents").notNull().default(0),
  // Referrals (F15) — shareable code; lazily backfilled for older orgs.
  referralCode: text("referral_code"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  slugIdx: uniqueIndex("organizations_slug_idx").on(t.slug),
  referralCodeIdx: uniqueIndex("organizations_referral_code_idx").on(t.referralCode),
}));

// ─── Users ─────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  name: text("name"),
  passwordHash: text("password_hash"),
  emailVerified: boolean("email_verified").notNull().default(false),
  emailVerifiedAt: timestamp("email_verified_at"),
  role: text("role").notNull().default("member"), // owner | admin | member
  // Audit #40: this column is what every API's auth looks users up by —
  // it was missing from the schema while existing in the live DB.
  supabaseUserId: text("supabase_user_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  emailIdx: uniqueIndex("users_email_idx").on(t.email),
  supabaseUserIdIdx: uniqueIndex("users_supabase_user_id_idx").on(t.supabaseUserId),
  orgIdx: index("users_org_idx").on(t.organizationId),
  emailLowerIdx: index("users_email_lower_idx").on(sql`lower(${t.email})`),
}));

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const emailVerificationTokens = pgTable("email_verification_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  tokenIdx: uniqueIndex("email_verification_tokens_token_idx").on(t.token),
}));

// ─── Payment Provider Connections (Razorpay) ──────────────────────────────────

export const stripeConnections = pgTable("stripe_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  encryptedRestrictedKey: text("encrypted_restricted_key").notNull(), // Razorpay Key Secret, AES-256-GCM encrypted
  keyIv: text("key_iv").notNull(),
  keyTag: text("key_tag").notNull(),
  stripeAccountId: text("stripe_account_id"),          // holds Razorpay Key ID (rzp_live_xxx)
  webhookEndpointId: text("webhook_endpoint_id"),
  webhookSecret: text("webhook_secret"),               // Razorpay webhook signing secret
  isActive: boolean("is_active").notNull().default(true),
  lastSyncedAt: timestamp("last_synced_at"),
  backfillCompletedAt: timestamp("backfill_completed_at"),
  connectedAt: timestamp("connected_at").notNull().defaultNow(),
  revokedAt: timestamp("revoked_at"),
}, (t) => ({
  orgIdx: uniqueIndex("stripe_connections_org_idx").on(t.organizationId),
}));

// ─── Stripe Members (customers synced from Stripe) ────────────────────────────

export const stripeMembers = pgTable("stripe_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  email: text("email"),
  name: text("name"),
  phone: text("phone"),                                 // for the SMS recovery channel
  metadata: jsonb("metadata"),
  // Timezone detected from payment history for smart retry timing
  detectedTimezone: text("detected_timezone"),
  bestPaymentHour: integer("best_payment_hour"), // 0-23 local hour
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  orgCustomerIdx: uniqueIndex("stripe_members_org_customer_idx").on(t.organizationId, t.stripeCustomerId),
}));

// ─── Stripe Subscriptions ─────────────────────────────────────────────────────

export const stripeSubscriptions = pgTable("stripe_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  memberId: uuid("member_id").notNull().references(() => stripeMembers.id, { onDelete: "cascade" }),
  stripeSubscriptionId: text("stripe_subscription_id").notNull(),
  status: text("status").notNull(), // active | past_due | canceled | unpaid
  planName: text("plan_name"),
  amountCents: integer("amount_cents"),
  currency: text("currency").notNull().default("usd"),
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  canceledAt: timestamp("canceled_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  orgSubIdx: uniqueIndex("stripe_subscriptions_org_sub_idx").on(t.organizationId, t.stripeSubscriptionId),
}));

// ─── Raw Webhook Events ────────────────────────────────────────────────────────

export const webhookEvents = pgTable("webhook_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  stripeEventId: text("stripe_event_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  processedAt: timestamp("processed_at"),
  processingError: text("processing_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  stripeEventIdx: uniqueIndex("webhook_events_stripe_event_idx").on(t.stripeEventId),
  orgIdx: index("webhook_events_org_idx").on(t.organizationId),
}));

// ─── Recovery Cases ────────────────────────────────────────────────────────────

export const recoveryCases = pgTable("recovery_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  memberId: uuid("member_id").notNull().references(() => stripeMembers.id),
  subscriptionId: uuid("subscription_id").references(() => stripeSubscriptions.id),
  stripeInvoiceId: text("stripe_invoice_id").notNull(),
  stripeChargeId: text("stripe_charge_id"),
  status: recoveryCaseStatusEnum("status").notNull().default("detected"),
  declineCode: declineCodeEnum("decline_code").notNull().default("unknown"),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("usd"),
  // Retry scheduling
  nextRetryAt: timestamp("next_retry_at"),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(3),
  // Checkout link
  checkoutToken: text("checkout_token"),
  checkoutExpiresAt: timestamp("checkout_expires_at"),
  // Recovery result
  recoveredAt: timestamp("recovered_at"),
  recoverySource: recoverySourceEnum("recovery_source"),
  lostAt: timestamp("lost_at"),
  // Timestamps
  failedAt: timestamp("failed_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  orgIdx: index("recovery_cases_org_idx").on(t.organizationId),
  statusIdx: index("recovery_cases_status_idx").on(t.status),
  orgStatusIdx: index("recovery_cases_org_status_idx").on(t.organizationId, t.status),
  invoiceIdx: uniqueIndex("recovery_cases_invoice_idx").on(t.stripeInvoiceId),
  checkoutTokenIdx: uniqueIndex("recovery_cases_checkout_token_idx").on(t.checkoutToken),
}));

// ─── Recovery Attempts (individual retry/note/checkout tries) ─────────────────

export const recoveryAttempts = pgTable("recovery_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: uuid("case_id").notNull().references(() => recoveryCases.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  type: recoverySourceEnum("type").notNull(),
  status: text("status").notNull().default("pending"), // pending | success | failed
  idempotencyKey: text("idempotency_key"),             // rv:{org}:{case}:{attempt}
  stripeChargeId: text("stripe_charge_id"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  approvedAt: timestamp("approved_at"),
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  executedAt: timestamp("executed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  // Audit #42: without a unique index the 409-on-race protection is fiction.
  idempotencyKeyIdx: uniqueIndex("recovery_attempts_idempotency_key_idx").on(t.idempotencyKey),
  orgCaseIdx: index("recovery_attempts_org_case_idx").on(t.organizationId, t.caseId),
}));

// ─── Recovery Attributions (per-dollar attribution ledger) ────────────────────

export const recoveryAttributions = pgTable("recovery_attributions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  caseId: uuid("case_id").notNull().references(() => recoveryCases.id),
  memberId: uuid("member_id").notNull().references(() => stripeMembers.id),
  source: recoverySourceEnum("source").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("usd"),
  recoveredAt: timestamp("recovered_at").notNull(),
  attributionWindowDays: integer("attribution_window_days").notNull().default(90),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  orgIdx: index("recovery_attributions_org_idx").on(t.organizationId),
}));

// ─── Recovery Notes (AI dunning emails) ───────────────────────────────────────

export const recoveryNotes = pgTable("recovery_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: uuid("case_id").notNull().references(() => recoveryCases.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  channel: text("channel").notNull().default("email"), // email | sms
  // Approval
  requiresApproval: boolean("requires_approval").notNull().default(true),
  approvedAt: timestamp("approved_at"),
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  rejectedAt: timestamp("rejected_at"),
  // Send status
  sentAt: timestamp("sent_at"),
  resendEmailId: text("resend_email_id"),
  openedAt: timestamp("opened_at"),
  clickedAt: timestamp("clicked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(), // audit #40
});

// ─── Voice Profiles (org writing style for AI emails) ─────────────────────────

export const voiceProfiles = pgTable("voice_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  brandName: text("brand_name").notNull(),
  senderName: text("sender_name").notNull(),
  senderEmail: text("sender_email").notNull(),
  toneDescription: text("tone_description"),            // "friendly but professional"
  smsEnabled: boolean("sms_enabled").notNull().default(false), // SMS recovery channel toggle
  exampleEmail: text("example_email"),                  // sample email to train the AI
  systemPromptAddition: text("system_prompt_addition"), // extra instructions
  isDefault: boolean("is_default").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  orgIdx: index("voice_profiles_org_idx").on(t.organizationId),
}));

// ─── Expansion Signals & Opportunities ────────────────────────────────────────

export const expansionOpportunities = pgTable("expansion_opportunities", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  memberId: uuid("member_id").notNull().references(() => stripeMembers.id),
  status: expansionStatusEnum("status").notNull().default("drafted"),
  signal: text("signal").notNull(),                    // "approaching usage limit"
  draftedSubject: text("drafted_subject"),
  draftedBody: text("drafted_body"),
  suggestedPriceDeltaCents: integer("suggested_price_delta_cents"),
  // Approval
  approvedAt: timestamp("approved_at"),
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  // Result
  sentAt: timestamp("sent_at"),
  resendEmailId: text("resend_email_id"),
  acceptedAt: timestamp("accepted_at"),
  revenueDeltaCents: integer("revenue_delta_cents"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  orgIdx: index("expansion_opportunities_org_idx").on(t.organizationId),
}));

// ─── Activity Feed ─────────────────────────────────────────────────────────────

export const activityFeed = pgTable("activity_feed", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // recovered | lost | note_sent | checkout_sent | upgrade_sent | connected
  title: text("title").notNull(),
  description: text("description"),
  amountCents: integer("amount_cents"),
  currency: text("currency"),
  memberId: uuid("member_id").references(() => stripeMembers.id),
  caseId: uuid("case_id").references(() => recoveryCases.id),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  orgIdx: index("activity_feed_org_idx").on(t.organizationId),
  orgCreatedIdx: index("activity_feed_org_created_idx").on(t.organizationId, t.createdAt),
}));

// ─── Decline Forensics Digests ────────────────────────────────────────────────

export const forensicsDigests = pgTable("forensics_digests", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  weekStartDate: timestamp("week_start_date").notNull(),
  weekEndDate: timestamp("week_end_date").notNull(),
  totalFailed: integer("total_failed").notNull().default(0),
  totalRecovered: integer("total_recovered").notNull().default(0),
  totalLost: integer("total_lost").notNull().default(0),
  recoveredAmountCents: bigint("recovered_amount_cents", { mode: "number" }).notNull().default(0),
  lostAmountCents: bigint("lost_amount_cents", { mode: "number" }).notNull().default(0),
  topDeclineReasons: jsonb("top_decline_reasons"),     // [{code, count, pct}]
  aiNarrativeParagraph: text("ai_narrative_paragraph"),
  sentAt: timestamp("sent_at"),
  resendEmailId: text("resend_email_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  orgWeekIdx: uniqueIndex("forensics_digests_org_week_idx").on(t.organizationId, t.weekStartDate),
}));

// ─── API Keys (F13) ────────────────────────────────────────────────────────────
// Programmatic access to org metrics via X-API-Key. Only the SHA-256 hash of
// the full key is stored; keyPrefix (first 12 chars) is what the API uses for
// lookup and what the UI ever displays. Deleting = soft revoke (revokedAt).

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull(),               // sha256(fullKey) hex
  label: text("label"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
}, (t) => ({
  prefixIdx: uniqueIndex("api_keys_prefix_idx").on(t.keyPrefix),
  orgIdx: index("api_keys_org_idx").on(t.organizationId),
}));

// ─── Changelog (F14) ───────────────────────────────────────────────────────────
// Public product updates rendered on /changelog.html. Rows are inserted
// manually (Neon SQL editor / psql) — no admin UI by design.

export const changelogEntries = pgTable("changelog_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  publishedAt: timestamp("published_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── Referrals (F15) ───────────────────────────────────────────────────────────
// One row per signup attributed to a referral code. referrerOrganizationId is
// denormalized from the code at signup time so later code changes never
// rewrite history.

export const referrals = pgTable("referrals", {
  id: uuid("id").primaryKey().defaultRandom(),
  referrerOrganizationId: uuid("referrer_organization_id").notNull().references(() => organizations.id),
  referredOrganizationId: uuid("referred_organization_id").references(() => organizations.id),
  referralCode: text("referral_code").notNull(),
  signedUpAt: timestamp("signed_up_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  referrerIdx: index("referrals_referrer_idx").on(t.referrerOrganizationId),
  codeIdx: index("referrals_code_idx").on(t.referralCode),
}));
