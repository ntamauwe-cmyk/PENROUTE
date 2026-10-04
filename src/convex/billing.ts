/**
 * ============================================================================
 * BILLING — Penroute processing-fee charges, employer billing and revenue
 * reporting.
 * ----------------------------------------------------------------------------
 * - One billingCharge per contribution batch (unique batchId = idempotency).
 * - The pricing snapshot (tier + fee per posting) is written ONCE when the
 *   batch is first quoted; later pricing changes never rewrite it.
 * - Revenue is recognised ONLY for charges with status "paid" (plus an
 *   explicit recognizedAt timestamp). Pending/failed/reversed charges are
 *   never counted as revenue.
 * - Pension contributions are recorded for reconciliation ONLY — they are
 *   employer funds routed to PFAs, never Penroute revenue.
 * - All pricing/admin surfaces are administrator-only; employers can read
 *   their own billing via getEmployerBilling and nothing else.
 * ============================================================================
 */
import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser } from "./users";
import { audit, getEmployerForUser } from "./employers";
import { loadActivePlans, loadEffectiveTiers, quoteForPostings } from "./pricing";
import { DEFAULT_SCENARIO_VOLUMES, revenueScenarios } from "../lib/pricing";

// ----------------------------------------------------------------------------
// Helpers (plain functions — called inside engine mutations)
// ----------------------------------------------------------------------------

// Reference generation uses the shared CSPRNG helper (src/lib/security.ts).

export function periodKeyOf(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function periodBounds(periodKey: string): { start: number; end: number } {
  const [y, m] = periodKey.split("-").map(Number);
  return { start: new Date(y, m - 1, 1).getTime(), end: new Date(y, m, 1).getTime() };
}

/** Subscription fee applicable to a period for an employer (0 when none). */
async function subscriptionForPeriod(
  ctx: QueryCtx,
  employerId: Doc<"employers">["_id"],
  periodKey: string,
): Promise<{ planName: string; feeKobo: number } | null> {
  const subs = await ctx.db
    .query("employerSubscriptions")
    .withIndex("by_employer", (q) => q.eq("employerId", employerId))
    .take(10_000);
  const active = subs.find((s) => s.status === "active");
  if (!active) return null;
  const { start, end } = periodBounds(periodKey);
  const applies = active.startedAt < end && (active.endedAt === undefined || active.endedAt >= start);
  if (!applies) return null;
  return { planName: active.planName, feeKobo: active.monthlyPriceKobo };
}

/**
 * Create (or return) the billing charge for a batch — IDEMPOTENT by batchId.
 * The FIRST quote wins: an existing charge's pricing snapshot is never
 * rewritten, even if administrators change rates before payment settles.
 */
export async function syncBillingCharge(
  ctx: MutationCtx,
  args: {
    batch: Doc<"contributionBatches">;
    postingCount: number;
    contributionKobo: number;
    actor?: string;
    status?: "pending" | "failed";
  },
): Promise<Doc<"billingCharges">> {
  const existing = await ctx.db
    .query("billingCharges")
    .withIndex("by_batch", (q) => q.eq("batchId", args.batch._id))
    .first();
  if (existing) {
    // A retry after a failed attempt returns the charge to pending; a paid or
    // reversed charge is never downgraded by a stray retry.
    if (args.status === "failed" && existing.status === "pending") {
      await ctx.db.patch(existing._id, { status: "failed" });
      return { ...existing, status: "failed" };
    }
    if (args.status === "pending" && existing.status === "failed") {
      await ctx.db.patch(existing._id, { status: "pending" });
      return { ...existing, status: "pending" };
    }
    return existing;
  }

  const quote = await quoteForPostings(ctx, args.postingCount);
  const periodKey = periodKeyOf(args.batch.contributionYear, args.batch.contributionMonth);
  const subscription = await subscriptionForPeriod(ctx, args.batch.employerId, periodKey);
  const subscriptionFeeKobo = subscription?.feeKobo ?? 0;
  const processingFeeKobo = quote.processingFeeKobo;
  const now = Date.now();

  const chargeId = await ctx.db.insert("billingCharges", {
    batchId: args.batch._id,
    employerId: args.batch.employerId,
    periodKey,
    contributionYear: args.batch.contributionYear,
    contributionMonth: args.batch.contributionMonth,
    postingCount: args.postingCount,
    employeeHeadcount: args.postingCount, // tier basis = employee posting volume
    tierCode: quote.tier.code,
    tierLabel: quote.tier.label,
    tierMin: quote.tier.minEmployees,
    tierMax: quote.tier.maxEmployees ?? undefined,
    feePerPostingKobo: quote.feePerPostingKobo, // IMMUTABLE snapshot
    processingFeeKobo,
    contributionKobo: args.contributionKobo, // pension funds — not revenue
    subscriptionFeeKobo,
    totalChargeKobo: processingFeeKobo + subscriptionFeeKobo,
    totalProcessedKobo: args.contributionKobo + processingFeeKobo,
    transactionRef: `PRC-${args.batch.contributionYear}${String(args.batch.contributionMonth).padStart(2, "0")}-${randRef("", 6)}`,
    status: args.status ?? "pending",
    reconciliationStatus: args.batch.reconciliationStatus ?? "pending",
    createdAt: now,
    createdBy: args.actor,
  });
  return (await ctx.db.get(chargeId))!;
}

/** Recognise a charge as revenue once its payment is confirmed successful. */
export async function markChargePaid(
  ctx: MutationCtx,
  args: { batchId: Doc<"contributionBatches">["_id"]; paymentRef: string },
): Promise<void> {
  let charge = await ctx.db
    .query("billingCharges")
    .withIndex("by_batch", (q) => q.eq("batchId", args.batchId))
    .first();

  if (!charge) {
    // Legacy batch paid before the billing architecture existed — build the
    // charge from the batch's authoritative payment totals (no re-quote).
    const batch = await ctx.db.get(args.batchId);
    if (!batch) return;
    const postings = Math.max(1, batch.employeeCount);
    const legacyId = await ctx.db.insert("billingCharges", {
      batchId: batch._id,
      employerId: batch.employerId,
      periodKey: periodKeyOf(batch.contributionYear, batch.contributionMonth),
      contributionYear: batch.contributionYear,
      contributionMonth: batch.contributionMonth,
      postingCount: postings,
      employeeHeadcount: postings,
      tierCode: "legacy",
      tierLabel: "Historical pricing (pre-tier)",
      tierMin: 1,
      tierMax: undefined,
      feePerPostingKobo: Math.round(batch.platformFee / postings),
      processingFeeKobo: batch.platformFee,
      contributionKobo: batch.totalPensionAmount,
      subscriptionFeeKobo: 0,
      totalChargeKobo: batch.platformFee,
      totalProcessedKobo: batch.platformFee + batch.totalPensionAmount,
      transactionRef: `PRC-${batch.batchRef.replace(/^BATCH-/, "")}`,
      status: "paid",
      recognizedAt: Date.now(),
      reconciliationStatus: batch.reconciliationStatus,
      createdAt: Date.now(),
      createdBy: "system:backfill",
    });
    charge = await ctx.db.get(legacyId);
    return;
  }
  if (charge.status === "reversed") return; // reversals are terminal
  if (charge.status === "paid") return; // idempotent
  await ctx.db.patch(charge._id, {
    status: "paid",
    recognizedAt: Date.now(),
    paymentRef: args.paymentRef,
  });
}

/** Mark a charge failed (payment declined) — never counts as revenue. */
export async function markChargeFailed(
  ctx: MutationCtx,
  batchId: Doc<"contributionBatches">["_id"],
): Promise<void> {
  const charge = await ctx.db
    .query("billingCharges")
    .withIndex("by_batch", (q) => q.eq("batchId", batchId))
    .first();
  if (charge && charge.status === "pending") {
    await ctx.db.patch(charge._id, { status: "failed" });
  }
}

// ============================================================================
// EMPLOYER BILLING (read-only, employer-scoped — server-computed totals)
// ============================================================================

import { randRef } from "../lib/security";

export const getEmployerBilling = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const employer = await getEmployerForUser(ctx, user);
    if (!employer) return null;

    const charges = await ctx.db
      .query("billingCharges")
      .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
      .take(10_000);

    // One charge per batch (one batch per employer per month) → grouping is
    // bounded by the number of billing periods, never by record volume.
    const byPeriod = new Map<string, Doc<"billingCharges">[]>();
    for (const c of charges) {
      const list = byPeriod.get(c.periodKey) ?? [];
      list.push(c);
      byPeriod.set(c.periodKey, list);
    }

    const periods = [...byPeriod.entries()]
      .map(([periodKey, rows]) => {
        const paid = rows.filter((r) => r.status === "paid");
        const status = rows.every((r) => r.status === "paid")
          ? "paid"
          : rows.some((r) => r.status === "reversed")
            ? "reversed"
            : rows.some((r) => r.status === "paid")
              ? "partially_paid"
              : rows.some((r) => r.status === "failed")
                ? "failed"
                : "pending";
        return {
          periodKey,
          postingCount: rows.reduce((s, r) => s + r.postingCount, 0),
          feePerPostingKobo: rows[0]?.feePerPostingKobo ?? 0,
          tierLabel: rows[0]?.tierLabel ?? "—",
          processingFeeKobo: rows.reduce((s, r) => s + r.processingFeeKobo, 0),
          contributionKobo: rows.reduce((s, r) => s + r.contributionKobo, 0),
          totalProcessedKobo: rows.reduce((s, r) => s + r.totalProcessedKobo, 0),
          status,
          transactionRefs: rows.map((r) => r.transactionRef),
          paymentRefs: rows.map((r) => r.paymentRef).filter(Boolean) as string[],
          recognizedCount: paid.length,
        };
      })
      .sort((a, b) => b.periodKey.localeCompare(a.periodKey));

    // Subscription fee per period (from explicit assignments — never forced).
    const enriched = await Promise.all(
      periods.map(async (p) => {
        const sub = await subscriptionForPeriod(ctx, employer._id, p.periodKey);
        return {
          ...p,
          subscriptionPlan: sub?.planName ?? null,
          subscriptionFeeKobo: sub?.feeKobo ?? 0,
          totalPenrouteChargeKobo: p.processingFeeKobo + (sub?.feeKobo ?? 0),
        };
      }),
    );

    // Current period = the month in progress (even before a batch exists).
    const now = new Date();
    const currentKey = periodKeyOf(now.getFullYear(), now.getMonth() + 1);
    const currentRow = enriched.find((p) => p.periodKey === currentKey) ?? null;
    const currentSub = await subscriptionForPeriod(ctx, employer._id, currentKey);

    // Pending (unpaid) batch for the current period — quote computed server-side.
    const batches = await ctx.db
      .query("contributionBatches")
      .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
      .take(10_000);
    const pendingBatch = batches.find(
      (b) =>
        b.contributionYear === now.getFullYear() &&
        b.contributionMonth === now.getMonth() + 1 &&
        (b.status === "awaiting_payment" || b.status === "draft"),
    );
    let pending: {
      batchRef: string;
      postingCount: number;
      feePerPostingKobo: number;
      tierLabel: string;
      processingFeeKobo: number;
      pensionKobo: number;
    } | null = null;
    if (pendingBatch) {
      const records = await ctx.db
        .query("contributionRecords")
        .withIndex("by_batch", (q) => q.eq("batchId", pendingBatch._id))
        .take(10_000);
      const valid = records.filter((r) => r.validationStatus === "valid");
      if (valid.length > 0) {
        const quote = await quoteForPostings(ctx, valid.length);
        const pension = valid.reduce((s, r) => s + r.totalAmount, 0);
        pending = {
          batchRef: pendingBatch.batchRef,
          postingCount: valid.length,
          feePerPostingKobo: quote.feePerPostingKobo,
          tierLabel: quote.tier.label,
          processingFeeKobo: quote.processingFeeKobo,
          pensionKobo: pension,
        };
      }
    }

    const current = currentRow
      ? { ...currentRow, subscriptionPlan: currentSub?.planName ?? currentRow.subscriptionPlan, subscriptionFeeKobo: currentSub?.feeKobo ?? 0, totalPenrouteChargeKobo: currentRow.processingFeeKobo + (currentSub?.feeKobo ?? 0) }
      : null;

    return {
      employerName: employer.name,
      current,
      pending,
      currentSubscription: currentSub,
      history: enriched.filter((p) => p.periodKey !== currentKey).slice(0, 12),
      disclaimer:
        "Penroute processing fees and platform subscriptions are Penroute technology/service charges. They are separate from — and never part of — employee pension contributions, which are employer funds routed to the employee's PFA.",
    };
  },
});

// ============================================================================
// ADMIN — revenue reporting, analytics, charge management
// ============================================================================

async function requireAdmin(ctx: Parameters<typeof getCurrentUser>[0]) {
  const user = await getCurrentUser(ctx);
  if (!user) throw new Error("Not authenticated");
  if (user.role !== "admin") throw new Error("Admin access required");
  return user;
}

/**
 * Revenue report (aggregate only — no transaction dumps to the client).
 * Figures are REVENUE before operating costs — never presented as profit.
 */
export const getAdminRevenueReport = query({
  args: { months: v.optional(v.number()) },
  handler: async (ctx, { months }) => {
    await requireAdmin(ctx);
    const window = Math.min(Math.max(months ?? 12, 1), 36);
    const now = new Date();
    const periodKeys: string[] = [];
    for (let i = 0; i < window; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      periodKeys.push(periodKeyOf(d.getFullYear(), d.getMonth() + 1));
    }

    const byMonth: {
      periodKey: string;
      postingCount: number;
      processingFeeKobo: number;
      contributionKobo: number;
      chargeCount: number;
    }[] = [];
    const byTier = new Map<
      string,
      { tierCode: string; tierLabel: string; feePerPostingKobo: number; postingCount: number; processingFeeKobo: number }
    >();
    const byEmployerRaw = new Map<string, { postingCount: number; processingFeeKobo: number; chargeCount: number }>();
    const employerIds = new Set<Id<"employers">>();
    let totalPostings = 0;
    let totalProcessingKobo = 0;
    let totalContributionKobo = 0;
    let chargeCount = 0;

    for (const periodKey of periodKeys) {
      const rows = await ctx.db
        .query("billingCharges")
        .withIndex("by_period", (q) => q.eq("periodKey", periodKey))
        .take(10_000);
      const paid = rows.filter((r) => r.status === "paid");
      let mPostings = 0;
      let mFee = 0;
      let mContribution = 0;
      for (const c of paid) {
        mPostings += c.postingCount;
        mFee += c.processingFeeKobo;
        mContribution += c.contributionKobo;
        employerIds.add(c.employerId);

        const tier = byTier.get(c.tierCode) ?? {
          tierCode: c.tierCode,
          tierLabel: c.tierLabel,
          feePerPostingKobo: c.feePerPostingKobo,
          postingCount: 0,
          processingFeeKobo: 0,
        };
        tier.postingCount += c.postingCount;
        tier.processingFeeKobo += c.processingFeeKobo;
        byTier.set(c.tierCode, tier);

        const emp = byEmployerRaw.get(String(c.employerId)) ?? {
          postingCount: 0,
          processingFeeKobo: 0,
          chargeCount: 0,
        };
        emp.postingCount += c.postingCount;
        emp.processingFeeKobo += c.processingFeeKobo;
        emp.chargeCount += 1;
        byEmployerRaw.set(String(c.employerId), emp);
      }
      byMonth.push({
        periodKey,
        postingCount: mPostings,
        processingFeeKobo: mFee,
        contributionKobo: mContribution,
        chargeCount: paid.length,
      });
      totalPostings += mPostings;
      totalProcessingKobo += mFee;
      totalContributionKobo += mContribution;
      chargeCount += paid.length;
    }

    // Employer names for the window (bounded by employers with paid charges).
    const employers = await Promise.all([...employerIds].map((id) => ctx.db.get(id)));
    const nameById = new Map(
      employers.filter(Boolean).map((e) => [String(e!._id), e!.name]),
    );
    const byEmployer = [...byEmployerRaw.entries()]
      .map(([id, v]) => ({ employerId: id, employerName: nameById.get(id) ?? "Unknown", ...v }))
      .sort((a, b) => b.processingFeeKobo - a.processingFeeKobo)
      .slice(0, 100);

    // Subscription revenue: active assignments overlapping each window month.
    const subs = await ctx.db.query("employerSubscriptions").take(10_000);
    let subscriptionRevenueKobo = 0;
    for (const periodKey of periodKeys) {
      const { start, end } = periodBounds(periodKey);
      for (const s of subs) {
        const applies =
          s.startedAt < end && (s.endedAt === undefined || s.endedAt >= start);
        if (applies) subscriptionRevenueKobo += s.monthlyPriceKobo;
      }
    }

    return {
      windowMonths: window,
      periodKeys,
      totals: {
        postingCount: totalPostings,
        processingRevenueKobo: totalProcessingKobo,
        subscriptionRevenueKobo,
        grossServiceRevenueKobo: totalProcessingKobo + subscriptionRevenueKobo,
        pensionContributionValueKobo: totalContributionKobo,
        employerCount: employerIds.size,
        chargeCount,
      },
      byMonth,
      byTier: [...byTier.values()].sort((a, b) => b.processingFeeKobo - a.processingFeeKobo),
      byEmployer,
      disclaimer:
        "Revenue figures are gross service revenue before operating costs, payment-processor fees, infrastructure, support, compliance, taxes and other expenses. They are not profit.",
    };
  },
});

/** Scenario analytics driven by the ACTUALLY CONFIGURED pricing tiers. */
export const getRevenueAnalytics = query({
  args: { volumes: v.optional(v.array(v.number())) },
  handler: async (ctx, { volumes }) => {
    await requireAdmin(ctx);
    const tiers = await loadEffectiveTiers(ctx);
    const plans = await loadActivePlans(ctx);
    const scenarioVolumes =
      volumes && volumes.length > 0 ? volumes : DEFAULT_SCENARIO_VOLUMES;
    const scenarios = revenueScenarios(tiers, scenarioVolumes);
    return {
      scenarios,
      plans: plans.map((p) => ({
        code: p.code,
        name: p.name,
        monthlyPriceKobo: p.monthlyPriceKobo,
        priceIsFrom: p.priceIsFrom,
        active: p.active,
      })),
      subscriptionRevenueAllPlansKobo: plans.reduce((s, p) => s + p.monthlyPriceKobo, 0),
      disclaimer:
        "Projected gross REVENUE before operating costs — not profit. Figures are computed from the currently configured pricing tiers and subscription plans.",
    };
  },
});

/** Reverse a paid charge after a refund/chargeback — revenue is reduced. */
export const reverseCharge = mutation({
  args: { chargeId: v.id("billingCharges"), reason: v.string() },
  handler: async (ctx, { chargeId, reason }) => {
    const user = await requireAdmin(ctx);
    const charge = await ctx.db.get(chargeId);
    if (!charge) throw new Error("Billing charge not found");
    if (charge.status === "reversed") return { ok: true, unchanged: true };
    if (charge.status !== "paid") {
      throw new Error("Only paid charges can be reversed");
    }
    const now = Date.now();
    await ctx.db.patch(chargeId, {
      status: "reversed",
      reversedAt: now,
      reversalReason: reason.trim(),
    });
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: "billing_charge_reversed",
      entityType: "billingCharge",
      entityId: charge.transactionRef,
      employerId: charge.employerId,
      details: `Reversed ${charge.transactionRef} (₦${(charge.processingFeeKobo / 100).toLocaleString()} processing fee): ${reason.trim()}`,
    });
    return { ok: true };
  },
});

/**
 * Backfill charges for batches completed before this billing architecture
 * existed (idempotent — only batches without a charge are touched).
 */
export const backfillBillingCharges = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireAdmin(ctx);
    const batches = await ctx.db.query("contributionBatches").take(10_000);
    let created = 0;
    for (const batch of batches) {
      if (batch.paymentStatus !== "successful" && batch.paymentStatus !== "processing") continue;
      const existing = await ctx.db
        .query("billingCharges")
        .withIndex("by_batch", (q) => q.eq("batchId", batch._id))
        .first();
      if (existing) continue;
      await markChargePaid(ctx, { batchId: batch._id, paymentRef: batch.paymentRef ?? "—" });
      created++;
    }
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: "billing_charges_backfilled",
      entityType: "billingCharge",
      details: `Backfilled ${created} billing charge(s) for historically completed batches`,
    });
    return { ok: true, created };
  },
});

/** Admin list of recent charges (billing audit view). */
export const listChargesForAdmin = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requireAdmin(ctx);
    const rows = await ctx.db.query("billingCharges").take(10_000);
    const employers = await ctx.db.query("employers").take(10_000);
    const nameById = new Map(employers.map((e) => [String(e._id), e.name]));
    return rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.min(limit ?? 50, 200))
      .map((c) => ({
        ...c,
        employerName: nameById.get(String(c.employerId)) ?? "Unknown",
      }));
  },
});
