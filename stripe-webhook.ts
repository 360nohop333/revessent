// revessent/apps/web/src/app/api/webhooks/stripe/route.ts
// Stripe webhook handler — receives events, persists raw, enqueues jobs

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { db, webhookEvents, stripeConnections, recoveryCases, stripeMembers, stripeSubscriptions } from "@revessent/db";
import { eq, and } from "drizzle-orm";
import { recoveryQueue } from "@revessent/worker";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-06-20",
});

// Events we care about
const HANDLED_EVENTS = new Set([
  "invoice.payment_failed",
  "invoice.payment_succeeded",
  "invoice.paid",
  "charge.failed",
  "customer.subscription.deleted",
  "customer.subscription.updated",
  "customer.updated",
]);

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  // Find the org this webhook belongs to by looking up the endpoint secret
  // Stripe sends the webhook to our single endpoint; we verify per-org secret
  let event: Stripe.Event;
  let organizationId: string | null = null;

  // Try each active connection's webhook secret
  const connections = await db
    .select()
    .from(stripeConnections)
    .where(eq(stripeConnections.isActive, true));

  for (const conn of connections) {
    if (!conn.webhookSecret) continue;
    try {
      event = stripe.webhooks.constructEvent(body, signature, conn.webhookSecret);
      organizationId = conn.organizationId;
      break;
    } catch {
      // try next
    }
  }

  if (!organizationId || !event!) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Idempotency — skip if already processed
  const existing = await db
    .select({ id: webhookEvents.id, processedAt: webhookEvents.processedAt })
    .from(webhookEvents)
    .where(eq(webhookEvents.stripeEventId, event.id))
    .limit(1);

  if (existing.length > 0 && existing[0].processedAt) {
    return NextResponse.json({ received: true, skipped: "duplicate" });
  }

  // Persist raw event
  await db
    .insert(webhookEvents)
    .values({
      organizationId,
      stripeEventId: event.id,
      eventType: event.type,
      payload: event as any,
    })
    .onConflictDoNothing();

  // Skip events we don't handle
  if (!HANDLED_EVENTS.has(event.type)) {
    await db
      .update(webhookEvents)
      .set({ processedAt: new Date() })
      .where(eq(webhookEvents.stripeEventId, event.id));
    return NextResponse.json({ received: true });
  }

  // Process event
  try {
    await handleEvent(event, organizationId);
    await db
      .update(webhookEvents)
      .set({ processedAt: new Date() })
      .where(eq(webhookEvents.stripeEventId, event.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(webhookEvents)
      .set({ processingError: message })
      .where(eq(webhookEvents.stripeEventId, event.id));
    console.error(`Webhook processing error [${event.type}]:`, err);
    // Return 200 to prevent Stripe retries for non-transient errors
  }

  return NextResponse.json({ received: true });
}

// ─── Event handlers ───────────────────────────────────────────────────────────

async function handleEvent(event: Stripe.Event, organizationId: string) {
  switch (event.type) {

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      await onPaymentFailed(invoice, organizationId);
      break;
    }

    case "invoice.paid":
    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;
      await onPaymentSucceeded(invoice, organizationId);
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      await onSubscriptionCanceled(sub, organizationId);
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      await onSubscriptionUpdated(sub, organizationId);
      break;
    }
  }
}

async function onPaymentFailed(invoice: Stripe.Invoice, organizationId: string) {
  const stripeCustomerId = typeof invoice.customer === "string"
    ? invoice.customer
    : invoice.customer?.id;

  if (!stripeCustomerId) return;

  // Upsert member
  const [member] = await db
    .insert(stripeMembers)
    .values({
      organizationId,
      stripeCustomerId,
      email: invoice.customer_email ?? undefined,
      name: invoice.customer_name ?? undefined,
    })
    .onConflictDoUpdate({
      target: [stripeMembers.organizationId, stripeMembers.stripeCustomerId],
      set: {
        email: invoice.customer_email ?? undefined,
        name: invoice.customer_name ?? undefined,
        updatedAt: new Date(),
      },
    })
    .returning();

  // Detect decline code from latest charge
  const chargeId = typeof invoice.charge === "string" ? invoice.charge : invoice.charge?.id;
  const declineCode = detectDeclineCode(invoice);

  // Create recovery case
  const [recoveryCase] = await db
    .insert(recoveryCases)
    .values({
      organizationId,
      memberId: member.id,
      stripeInvoiceId: invoice.id,
      stripeChargeId: chargeId ?? undefined,
      status: "detected",
      declineCode,
      amountCents: invoice.amount_due,
      currency: invoice.currency,
      failedAt: new Date(invoice.created * 1000),
    })
    .onConflictDoNothing()
    .returning();

  if (!recoveryCase) return; // already exists

  // Enqueue recovery job
  await recoveryQueue.add(
    "process-recovery",
    { caseId: recoveryCase.id, organizationId },
    {
      jobId: `recovery:${recoveryCase.id}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
    }
  );
}

async function onPaymentSucceeded(invoice: Stripe.Invoice, organizationId: string) {
  // Mark any open recovery case for this invoice as recovered
  const openCase = await db
    .select()
    .from(recoveryCases)
    .where(
      and(
        eq(recoveryCases.stripeInvoiceId, invoice.id),
        eq(recoveryCases.organizationId, organizationId)
      )
    )
    .limit(1);

  if (openCase.length === 0) return;
  const rc = openCase[0];

  if (rc.status === "recovered") return;

  await db
    .update(recoveryCases)
    .set({
      status: "recovered",
      recoveredAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(recoveryCases.id, rc.id));

  // Enqueue attribution job
  await recoveryQueue.add(
    "attribute-recovery",
    { caseId: rc.id, organizationId },
    { jobId: `attr:${rc.id}` }
  );
}

async function onSubscriptionCanceled(sub: Stripe.Subscription, organizationId: string) {
  await db
    .update(stripeSubscriptions)
    .set({ status: "canceled", canceledAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(stripeSubscriptions.stripeSubscriptionId, sub.id),
        eq(stripeSubscriptions.organizationId, organizationId)
      )
    );
}

async function onSubscriptionUpdated(sub: Stripe.Subscription, organizationId: string) {
  await db
    .update(stripeSubscriptions)
    .set({ status: sub.status, updatedAt: new Date() })
    .where(
      and(
        eq(stripeSubscriptions.stripeSubscriptionId, sub.id),
        eq(stripeSubscriptions.organizationId, organizationId)
      )
    );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectDeclineCode(invoice: Stripe.Invoice): "expired_card" | "insufficient_funds" | "card_declined" | "processing_error" | "unknown" {
  // In a real impl, fetch the charge and read last_payment_error.decline_code
  // For now, use invoice metadata
  const raw = (invoice as any).last_payment_error?.decline_code as string | undefined;
  const map: Record<string, "expired_card" | "insufficient_funds" | "card_declined" | "processing_error"> = {
    expired_card: "expired_card",
    insufficient_funds: "insufficient_funds",
    card_declined: "card_declined",
    processing_error: "processing_error",
  };
  return map[raw ?? ""] ?? "unknown";
}
