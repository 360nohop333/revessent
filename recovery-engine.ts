// revessent/packages/server/src/recovery-engine.ts
// Core recovery state machine — decides what to do with each failed payment

import Stripe from "stripe";
import { db, recoveryCases, recoveryAttempts, stripeMembers, stripeConnections, organizations, voiceProfiles } from "@revessent/db";
import { eq, and } from "drizzle-orm";
import { decryptKey } from "./crypto";
import { generateRecoveryNote } from "./ai";
import { sendEmail } from "./email";
import { activityService } from "./activity";

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function processRecoveryCase(caseId: string, organizationId: string) {
  const [rc] = await db
    .select()
    .from(recoveryCases)
    .where(and(eq(recoveryCases.id, caseId), eq(recoveryCases.organizationId, organizationId)))
    .limit(1);

  if (!rc) throw new Error(`Recovery case not found: ${caseId}`);
  if (rc.status === "recovered" || rc.status === "lost" || rc.status === "canceled") {
    return { action: "skip", reason: "terminal state" };
  }

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  if (!org) throw new Error(`Organization not found: ${organizationId}`);

  const policy = getPolicy(rc.declineCode, rc.retryCount);

  switch (policy.action) {
    case "retry":
      return scheduleRetry(rc, org, policy.delayMs);

    case "send_note":
      return scheduleNote(rc, org);

    case "send_checkout":
      return scheduleCheckout(rc, org);

    case "mark_lost":
      return markLost(rc.id);

    default:
      return { action: "skip", reason: "no policy" };
  }
}

// ─── Policy (what to do based on decline code + attempt count) ────────────────

type PolicyAction = "retry" | "send_note" | "send_checkout" | "mark_lost";

interface Policy {
  action: PolicyAction;
  delayMs: number;
}

function getPolicy(
  declineCode: string,
  retryCount: number
): Policy {
  // Cards that should NOT be retried (permanent declines)
  const permanentDeclines = new Set([
    "lost_card", "stolen_card", "pickup_card", "invalid_account"
  ]);

  if (permanentDeclines.has(declineCode)) {
    // Go straight to recovery note + checkout
    if (retryCount === 0) return { action: "send_note", delayMs: 0 };
    return { action: "mark_lost", delayMs: 0 };
  }

  // Retriable declines — try up to 3 times with smart timing
  if (retryCount === 0) {
    // First retry: within 24h at member's best payment hour
    return { action: "retry", delayMs: hoursMs(2) };
  }

  if (retryCount === 1) {
    // Second retry: 3 days later
    return { action: "retry", delayMs: daysMs(3) };
  }

  if (retryCount === 2) {
    // Third retry: 5 days later
    return { action: "retry", delayMs: daysMs(5) };
  }

  // All retries exhausted → send recovery note
  if (retryCount === 3) {
    return { action: "send_note", delayMs: 0 };
  }

  // Note sent, still not recovered → send checkout link
  if (retryCount === 4) {
    return { action: "send_checkout", delayMs: daysMs(3) };
  }

  // Everything exhausted
  return { action: "mark_lost", delayMs: 0 };
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function scheduleRetry(
  rc: typeof recoveryCases.$inferSelect,
  org: typeof organizations.$inferSelect,
  delayMs: number
) {
  // Calculate best retry time using member's payment history
  const member = await db
    .select()
    .from(stripeMembers)
    .where(eq(stripeMembers.id, rc.memberId))
    .limit(1)
    .then((r) => r[0]);

  const retryAt = calculateBestRetryTime(member, delayMs);

  await db
    .update(recoveryCases)
    .set({
      status: "retrying",
      nextRetryAt: retryAt,
      updatedAt: new Date(),
    })
    .where(eq(recoveryCases.id, rc.id));

  return {
    action: "retry_scheduled",
    retryAt: retryAt.toISOString(),
    memberName: member?.name ?? "Unknown",
  };
}

async function scheduleNote(
  rc: typeof recoveryCases.$inferSelect,
  org: typeof organizations.$inferSelect
) {
  // Get voice profile
  const [voice] = await db
    .select()
    .from(voiceProfiles)
    .where(and(eq(voiceProfiles.organizationId, org.id), eq(voiceProfiles.isDefault, true)))
    .limit(1);

  const member = await db
    .select()
    .from(stripeMembers)
    .where(eq(stripeMembers.id, rc.memberId))
    .limit(1)
    .then((r) => r[0]);

  // Generate AI recovery note
  const note = await generateRecoveryNote({
    memberName: member?.name ?? "there",
    memberEmail: member?.email ?? "",
    amountCents: rc.amountCents,
    currency: rc.currency,
    declineCode: rc.declineCode,
    brandName: voice?.brandName ?? org.name,
    senderName: voice?.senderName ?? "The team",
    toneDescription: voice?.toneDescription ?? "friendly but professional",
    exampleEmail: voice?.exampleEmail ?? null,
    checkoutUrl: buildCheckoutUrl(rc.checkoutToken),
  });

  // Create recovery note record
  const requiresApproval = org.trustLevel === "approval_required";

  const [{ id: noteId }] = await db
    .insert((await import("@revessent/db")).recoveryNotes)
    .values({
      caseId: rc.id,
      organizationId: org.id,
      subject: note.subject,
      body: note.body,
      requiresApproval,
    })
    .returning({ id: (await import("@revessent/db")).recoveryNotes.id });

  await db
    .update(recoveryCases)
    .set({ status: "awaiting_approval", updatedAt: new Date() })
    .where(eq(recoveryCases.id, rc.id));

  // If autonomous, send immediately
  if (!requiresApproval && voice) {
    await sendRecoveryNote(noteId, voice.senderEmail, member?.email ?? "");
  }

  return { action: "note_drafted", requiresApproval, noteId };
}

async function scheduleCheckout(
  rc: typeof recoveryCases.$inferSelect,
  org: typeof organizations.$inferSelect
) {
  // Generate unguessable checkout token
  const token = generateToken();
  const expiresAt = new Date(Date.now() + daysMs(14));

  await db
    .update(recoveryCases)
    .set({
      status: "checkout_sent",
      checkoutToken: token,
      checkoutExpiresAt: expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(recoveryCases.id, rc.id));

  return { action: "checkout_scheduled", token, expiresAt: expiresAt.toISOString() };
}

async function markLost(caseId: string) {
  await db
    .update(recoveryCases)
    .set({ status: "lost", lostAt: new Date(), updatedAt: new Date() })
    .where(eq(recoveryCases.id, caseId));

  return { action: "marked_lost" };
}

// ─── Execute retry against Stripe ─────────────────────────────────────────────

export async function executeRetry(caseId: string, organizationId: string) {
  const [rc] = await db
    .select()
    .from(recoveryCases)
    .where(eq(recoveryCases.id, caseId))
    .limit(1);

  if (!rc || rc.status !== "retrying") {
    return { success: false, reason: "not in retrying state" };
  }

  // Get Stripe connection
  const [conn] = await db
    .select()
    .from(stripeConnections)
    .where(and(eq(stripeConnections.organizationId, organizationId), eq(stripeConnections.isActive, true)))
    .limit(1);

  if (!conn) return { success: false, reason: "no stripe connection" };

  const apiKey = decryptKey(conn.encryptedRestrictedKey, conn.keyIv, conn.keyTag);
  const stripe = new Stripe(apiKey, { apiVersion: "2024-06-20" });

  const idempotencyKey = `rv:${organizationId}:${caseId}:${rc.retryCount}`;

  // Log attempt
  const [attempt] = await db
    .insert(recoveryAttempts)
    .values({
      caseId,
      organizationId,
      type: "retry",
      status: "pending",
      idempotencyKey,
    })
    .returning();

  try {
    await stripe.invoices.pay(rc.stripeInvoiceId, {}, { idempotencyKey });

    await db
      .update(recoveryAttempts)
      .set({ status: "success", executedAt: new Date() })
      .where(eq(recoveryAttempts.id, attempt.id));

    await db
      .update(recoveryCases)
      .set({ retryCount: rc.retryCount + 1, updatedAt: new Date() })
      .where(eq(recoveryCases.id, caseId));

    return { success: true };
  } catch (err) {
    const stripeErr = err as Stripe.errors.StripeError;

    await db
      .update(recoveryAttempts)
      .set({
        status: "failed",
        errorCode: stripeErr.code ?? "unknown",
        errorMessage: stripeErr.message,
        executedAt: new Date(),
      })
      .where(eq(recoveryAttempts.id, attempt.id));

    await db
      .update(recoveryCases)
      .set({ retryCount: rc.retryCount + 1, updatedAt: new Date() })
      .where(eq(recoveryCases.id, caseId));

    return { success: false, errorCode: stripeErr.code };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calculateBestRetryTime(
  member: typeof stripeMembers.$inferSelect | undefined,
  baseDelayMs: number
): Date {
  const base = new Date(Date.now() + baseDelayMs);

  if (!member?.bestPaymentHour) return base;

  // Adjust to member's best payment hour in their timezone
  const tz = member.detectedTimezone ?? "UTC";
  try {
    const localHour = new Intl.DateTimeFormat("en", {
      hour: "numeric",
      hour12: false,
      timeZone: tz,
    }).format(base);

    const diff = member.bestPaymentHour - parseInt(localHour);
    const adjusted = new Date(base.getTime() + diff * 60 * 60 * 1000);
    return adjusted;
  } catch {
    return base;
  }
}

function buildCheckoutUrl(token: string | null): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return token ? `${base}/c/${token}` : "";
}

function generateToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendRecoveryNote(noteId: string, fromEmail: string, toEmail: string) {
  // Implementation: fetch note, send via Resend
  // This is called when org trust level is autonomous
}

const hoursMs = (h: number) => h * 60 * 60 * 1000;
const daysMs = (d: number) => d * 24 * 60 * 60 * 1000;
