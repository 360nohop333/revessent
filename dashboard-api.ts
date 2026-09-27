// revessent/apps/web/src/app/api/v1/dashboard/route.ts
// Dashboard overview data — KPIs, recovery queue, activity feed

import { NextRequest, NextResponse } from "next/server";
import { db, recoveryCases, recoveryAttributions, activityFeed, stripeMembers, organizations } from "@revessent/db";
import { eq, and, gte, lte, desc, sql, count, sum } from "drizzle-orm";
import { getSession } from "@revessent/server/auth";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orgId = session.user.organizationId;
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Run all queries in parallel
  const [
    org,
    kpis,
    revenueAtRisk,
    recoveryQueue,
    feed,
    weeklyChart,
  ] = await Promise.all([
    // Org info
    db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
      .then((r) => r[0]),

    // KPIs: recovered last 30d
    db
      .select({
        totalRecovered: count(),
        recoveredAmountCents: sum(recoveryAttributions.amountCents),
      })
      .from(recoveryAttributions)
      .where(
        and(
          eq(recoveryAttributions.organizationId, orgId),
          gte(recoveryAttributions.recoveredAt, thirtyDaysAgo)
        )
      )
      .then((r) => r[0]),

    // Revenue at risk: open cases
    db
      .select({
        count: count(),
        totalCents: sum(recoveryCases.amountCents),
      })
      .from(recoveryCases)
      .where(
        and(
          eq(recoveryCases.organizationId, orgId),
          sql`${recoveryCases.status} NOT IN ('recovered', 'lost', 'canceled')`
        )
      )
      .then((r) => r[0]),

    // Recovery queue: cases needing attention
    db
      .select({
        id: recoveryCases.id,
        status: recoveryCases.status,
        amountCents: recoveryCases.amountCents,
        currency: recoveryCases.currency,
        declineCode: recoveryCases.declineCode,
        failedAt: recoveryCases.failedAt,
        nextRetryAt: recoveryCases.nextRetryAt,
        memberName: stripeMembers.name,
        memberEmail: stripeMembers.email,
      })
      .from(recoveryCases)
      .leftJoin(stripeMembers, eq(recoveryCases.memberId, stripeMembers.id))
      .where(
        and(
          eq(recoveryCases.organizationId, orgId),
          sql`${recoveryCases.status} NOT IN ('recovered', 'lost', 'canceled')`
        )
      )
      .orderBy(desc(recoveryCases.failedAt))
      .limit(20),

    // Activity feed
    db
      .select({
        id: activityFeed.id,
        type: activityFeed.type,
        title: activityFeed.title,
        description: activityFeed.description,
        amountCents: activityFeed.amountCents,
        currency: activityFeed.currency,
        createdAt: activityFeed.createdAt,
      })
      .from(activityFeed)
      .where(eq(activityFeed.organizationId, orgId))
      .orderBy(desc(activityFeed.createdAt))
      .limit(25),

    // Weekly chart: last 8 weeks
    buildWeeklyChart(orgId),
  ]);

  return NextResponse.json({
    org: {
      id: org.id,
      name: org.name,
      plan: org.plan,
      trustLevel: org.trustLevel,
      pilotEndsAt: org.pilotEndsAt,
      isPilot: org.plan === "ember",
    },
    kpis: {
      recoveredLast30d: Number(kpis.totalRecovered ?? 0),
      recoveredAmountCentsLast30d: Number(kpis.recoveredAmountCents ?? 0),
      revenueAtRiskCount: Number(revenueAtRisk.count ?? 0),
      revenueAtRiskCents: Number(revenueAtRisk.totalCents ?? 0),
    },
    recoveryQueue,
    activityFeed: feed,
    weeklyChart,
  });
}

// ─── Weekly chart data ────────────────────────────────────────────────────────

async function buildWeeklyChart(orgId: string) {
  const weeks: Array<{ weekStart: Date; weekEnd: Date; label: string }> = [];

  for (let i = 7; i >= 0; i--) {
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - i * 7 - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    weeks.push({
      weekStart,
      weekEnd,
      label: weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    });
  }

  const chartData = await Promise.all(
    weeks.map(async (week) => {
      const [recovered, lost] = await Promise.all([
        db
          .select({ count: count(), amount: sum(recoveryAttributions.amountCents) })
          .from(recoveryAttributions)
          .where(
            and(
              eq(recoveryAttributions.organizationId, orgId),
              gte(recoveryAttributions.recoveredAt, week.weekStart),
              lte(recoveryAttributions.recoveredAt, week.weekEnd)
            )
          )
          .then((r) => r[0]),
        db
          .select({ count: count() })
          .from(recoveryCases)
          .where(
            and(
              eq(recoveryCases.organizationId, orgId),
              eq(recoveryCases.status, "lost"),
              gte(recoveryCases.lostAt!, week.weekStart),
              lte(recoveryCases.lostAt!, week.weekEnd)
            )
          )
          .then((r) => r[0]),
      ]);

      return {
        week: week.label,
        recovered: Number(recovered.count ?? 0),
        recoveredCents: Number(recovered.amount ?? 0),
        lost: Number(lost.count ?? 0),
      };
    })
  );

  return chartData;
}
