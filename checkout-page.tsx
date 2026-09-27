// revessent/apps/web/src/app/c/[token]/page.tsx
// Member-facing recovery checkout — branded, no login required

import { notFound } from "next/navigation";
import { db, recoveryCases, stripeMembers, stripeConnections, organizations, voiceProfiles } from "@revessent/db";
import { eq, and } from "drizzle-orm";
import { CheckoutClient } from "./checkout-client";

interface Props {
  params: { token: string };
}

export default async function CheckoutPage({ params }: Props) {
  const { token } = params;

  // Find the recovery case by token
  const [rc] = await db
    .select()
    .from(recoveryCases)
    .where(eq(recoveryCases.checkoutToken, token))
    .limit(1);

  if (!rc) return notFound();

  // Check token is still valid
  if (rc.checkoutExpiresAt && rc.checkoutExpiresAt < new Date()) {
    return <ExpiredPage />;
  }

  if (rc.status === "recovered") {
    return <AlreadyRecoveredPage />;
  }

  // Fetch related data
  const [member, org, voice, conn] = await Promise.all([
    db.select().from(stripeMembers).where(eq(stripeMembers.id, rc.memberId)).limit(1).then((r) => r[0]),
    db.select().from(organizations).where(eq(organizations.id, rc.organizationId)).limit(1).then((r) => r[0]),
    db.select().from(voiceProfiles).where(and(eq(voiceProfiles.organizationId, rc.organizationId), eq(voiceProfiles.isDefault, true))).limit(1).then((r) => r[0]),
    db.select().from(stripeConnections).where(and(eq(stripeConnections.organizationId, rc.organizationId), eq(stripeConnections.isActive, true))).limit(1).then((r) => r[0]),
  ]);

  if (!conn) return notFound();

  const brandName = voice?.brandName ?? org?.name ?? "Your subscription";
  const amount = formatCurrency(rc.amountCents, rc.currency);

  return (
    <CheckoutClient
      token={token}
      caseId={rc.id}
      memberName={member?.name ?? "there"}
      memberEmail={member?.email ?? ""}
      amountFormatted={amount}
      brandName={brandName}
      stripePublishableKey={process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!}
    />
  );
}

// ─── Status pages ─────────────────────────────────────────────────────────────

function ExpiredPage() {
  return (
    <StatusPage
      emoji="⏰"
      title="This link has expired"
      description="Payment links expire after 14 days. Please contact support to get a new one."
    />
  );
}

function AlreadyRecoveredPage() {
  return (
    <StatusPage
      emoji="✅"
      title="You're all set"
      description="Your payment has already been processed. Thank you!"
    />
  );
}

function StatusPage({ emoji, title, description }: { emoji: string; title: string; description: string }) {
  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f9fafb" }}>
      <div style={{ textAlign: "center", maxWidth: 400, padding: "0 24px" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>{emoji}</div>
        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>{title}</h1>
        <p style={{ color: "#6b7280", lineHeight: 1.6 }}>{description}</p>
      </div>
    </main>
  );
}

function formatCurrency(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}
