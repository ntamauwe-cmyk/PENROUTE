/**
 * ============================================================================
 * PRICING SERVICE — central, administrator-configurable pricing for Penroute.
 * ----------------------------------------------------------------------------
 * The ONLY place rates are read/written. The engine (src/lib/pricing.ts)
 * computes quotes; this module owns persistence, effective dating, versioning,
 * validation and the audit trail. Employers can read prices; only
 * administrators can change them.
 * ============================================================================
 */
import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { getCurrentUser } from "./users";
import { audit } from "./employers";
import {
  DEFAULT_PRICING_TIERS,
  DEFAULT_SUBSCRIPTION_PLANS,
  computeProcessingFee,
  tierRangeLabel,
  type PricingTier,
} from "../lib/pricing";

async function requireAdmin(ctx: Parameters<typeof getCurrentUser>[0]) {
  const user = await getCurrentUser(ctx);
  if (!user) throw new Error("Not authenticated");
  if (user.role !== "admin") throw new Error("Admin access required");
  return user;
}

/** Seed default tiers/plans once — mutation (writer) context only. */
async function ensurePricingSeeded(ctx: MutationCtx) {
  if (!(await ctx.db.query("pricingTiers").first())) {
    const now = Date.now() - 1000;
    for (const t of DEFAULT_PRICING_TIERS) {
      await ctx.db.insert("pricingTiers", {
        code: t.code,
        label: t.label,
        minEmployees: t.minEmployees,
        maxEmployees: t.maxEmployees ?? undefined,
        feePerPostingKobo: t.feePerPostingKobo,
        active: true,
        effectiveFrom: now,
        createdAt: now,
        createdBy: "system:seed",
      });
    }
  }
  if (!(await ctx.db.query("subscriptionPlans").first())) {
    const now = Date.now() - 1000;
    for (const p of DEFAULT_SUBSCRIPTION_PLANS) {
      await ctx.db.insert("subscriptionPlans", {
        code: p.code,
        name: p.name,
        monthlyPriceKobo: p.monthlyPriceKobo,
        priceIsFrom: p.priceIsFrom,
        description: p.description,
        active: true,
        createdAt: now,
        createdBy: "system:seed",
      });
    }
  }
}

/**
 * Currently-effective ACTIVE tiers as plain pricing-engine rows. While the
 * table is still empty (no admin has saved yet) the central defaults apply
 * virtually — single source of truth either way.
 */
export async function loadEffectiveTiers(ctx: QueryCtx, at: number = Date.now()): Promise<PricingTier[]> {
  const rows = await ctx.db.query("pricingTiers").collect();
  if (rows.length === 0) return [...DEFAULT_PRICING_TIERS];
  const effective = rows.filter(
    (r) => r.active && r.effectiveFrom <= at && (r.effectiveTo === undefined || r.effectiveTo > at),
  );
  if (effective.length === 0) {
    throw new Error("No active pricing tiers are configured — pricing cannot be quoted");
  }
  return effective
    .map((r) => ({
      code: r.code,
      label: r.label,
      minEmployees: r.minEmployees,
      maxEmployees: r.maxEmployees ?? null,
      feePerPostingKobo: r.feePerPostingKobo,
    }))
    .sort((a, b) => a.minEmployees - b.minEmployees);
}

/** Server-side quote — the ONLY way any screen learns a rate. */
export async function quoteForPostings(ctx: QueryCtx, postings: number) {
  const tiers = await loadEffectiveTiers(ctx);
  return computeProcessingFee(tiers, postings);
}

export type ActivePlan = {
  code: string;
  name: string;
  monthlyPriceKobo: number;
  priceIsFrom: boolean;
  description?: string;
  active: boolean;
};

/** Currently-effective active subscription plans (defaults until first save). */
export async function loadActivePlans(ctx: QueryCtx): Promise<ActivePlan[]> {
  const rows = await ctx.db.query("subscriptionPlans").collect();
  if (rows.length === 0) {
    return DEFAULT_SUBSCRIPTION_PLANS.map((p) => ({ ...p, active: true }));
  }
  return rows
    .filter((r) => r.active)
    .sort((a, b) => a.monthlyPriceKobo - b.monthlyPriceKobo)
    .map((r) => ({
      code: r.code,
      name: r.name,
      monthlyPriceKobo: r.monthlyPriceKobo,
      priceIsFrom: r.priceIsFrom,
      description: r.description,
      active: r.active,
    }));
}

/** Range overlap check — active tiers must partition volumes unambiguously. */
function rangesOverlap(
  a: { min: number; max: number | null },
  b: { min: number; max: number | null },
): boolean {
  const aMax = a.max ?? Number.POSITIVE_INFINITY;
  const bMax = b.max ?? Number.POSITIVE_INFINITY;
  return !(aMax < b.min || bMax < a.min);
}

// ============================================================================
// PUBLIC / EMPLOYER QUERIES
// ============================================================================

/** Public pricing (active tiers + plans) — no session required. */
export const getPublicPricing = query({
  args: {},
  handler: async (ctx) => {
    const tiers = await loadEffectiveTiers(ctx);
    const plans = await loadActivePlans(ctx);
    return {
      tiers,
      plans: plans.map((p) => ({
        code: p.code,
        name: p.name,
        monthlyPriceKobo: p.monthlyPriceKobo,
        priceIsFrom: p.priceIsFrom,
        description: p.description ?? "",
      })),
    };
  },
});

/** Quote for a posting volume (signed-in users — wizard/settings previews). */
export const getQuote = query({
  args: { postings: v.number() },
  handler: async (ctx, { postings }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    if (!Number.isFinite(postings) || postings < 0) throw new Error("Invalid posting volume");
    const quote = await quoteForPostings(ctx, Math.floor(postings));
    return {
      postings: quote.postingCount,
      tierCode: quote.tier.code,
      tierLabel: quote.tier.label,
      tierMin: quote.tier.minEmployees,
      tierMax: quote.tier.maxEmployees,
      feePerPostingKobo: quote.feePerPostingKobo,
      processingFeeKobo: quote.processingFeeKobo,
    };
  },
});

// ============================================================================
// ADMIN — pricing management (administrator-only, fully audited)
// ============================================================================

/** Full pricing state for the admin pricing console (incl. history). */
export const getPricingForAdmin = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const [tiers, plans, subs, employers] = await Promise.all([
      ctx.db.query("pricingTiers").collect(),
      ctx.db.query("subscriptionPlans").collect(),
      ctx.db.query("employerSubscriptions").collect(),
      ctx.db.query("employers").collect(),
    ]);
    const employerById = new Map(employers.map((e) => [String(e._id), e.name]));
    return {
      tiers: tiers.sort((a, b) => b.createdAt - a.createdAt),
      plans: plans.sort((a, b) => a.monthlyPriceKobo - b.monthlyPriceKobo),
      subscriptions: subs
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((s) => ({
          ...s,
          employerName: employerById.get(String(s.employerId)) ?? "Unknown employer",
        })),
      employers: employers
        .filter((e) => e.status !== "suspended")
        .map((e) => ({ employerId: e._id, name: e.name, rcNumber: e.rcNumber })),
    };
  },
});

/** Idempotent initializer — persists the central defaults as editable rows. */
export const initializePricing = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    await ensurePricingSeeded(ctx);
    const tiers = await ctx.db.query("pricingTiers").collect();
    const plans = await ctx.db.query("subscriptionPlans").collect();
    return { ok: true, tierCount: tiers.length, planCount: plans.length };
  },
});

/**
 * Audit trail for pricing/billing configuration changes — who changed a
 * price, from what to what, and when.
 */
export const getPricingAudit = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const [tierLogs, planLogs, chargeLogs] = await Promise.all([
      ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) => q.eq("entityType", "pricingTier"))
        .order("desc")
        .take(40),
      ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) => q.eq("entityType", "subscriptionPlan"))
        .order("desc")
        .take(40),
      ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) => q.eq("entityType", "billingCharge"))
        .order("desc")
        .take(20),
    ]);
    return [...tierLogs, ...planLogs, ...chargeLogs]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 60);
  },
});

/** Create a new pricing tier (new code). */
export const createTier = mutation({
  args: {
    label: v.string(),
    minEmployees: v.number(),
    maxEmployees: v.optional(v.number()),
    feePerPostingKobo: v.number(),
  },
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    await ensurePricingSeeded(ctx);
    const label = args.label.trim();
    if (!label) throw new Error("Tier label is required");
    if (!Number.isFinite(args.minEmployees) || args.minEmployees < 1) {
      throw new Error("Minimum employees must be at least 1");
    }
    if (args.maxEmployees !== undefined && args.maxEmployees < args.minEmployees) {
      throw new Error("Maximum employees must be >= minimum");
    }
    if (!Number.isFinite(args.feePerPostingKobo) || args.feePerPostingKobo < 0) {
      throw new Error("Fee per posting must be a non-negative number");
    }
    const candidate = {
      min: args.minEmployees,
      max: args.maxEmployees ?? null,
    };
    const active = (await ctx.db.query("pricingTiers").collect()).filter((t) => t.active);
    for (const t of active) {
      if (rangesOverlap(candidate, { min: t.minEmployees, max: t.maxEmployees ?? null })) {
        throw new Error(`Range overlaps active tier "${t.label}"`);
      }
    }
    const now = Date.now();
    const code = `tier-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const id = await ctx.db.insert("pricingTiers", {
      code,
      label,
      minEmployees: args.minEmployees,
      maxEmployees: args.maxEmployees,
      feePerPostingKobo: args.feePerPostingKobo,
      active: true,
      effectiveFrom: now,
      createdAt: now,
      createdBy: user.email ?? "admin",
    });
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: "pricing_tier_created",
      entityType: "pricingTier",
      entityId: code,
      details: `Created tier "${label}" (${tierRangeLabel(args.minEmployees, args.maxEmployees ?? null)}) at ₦${(args.feePerPostingKobo / 100).toFixed(2)} per posting`,
    });
    return { ok: true, tierId: id, code };
  },
});

/**
 * Update a tier. Rate/range changes SUPERSEDE: the old row is closed
 * (effectiveTo) and a successor version is inserted — pricing history and any
 * already-snapshotted billing records remain intact.
 */
export const updateTier = mutation({
  args: {
    tierId: v.id("pricingTiers"),
    label: v.optional(v.string()),
    minEmployees: v.optional(v.number()),
    maxEmployees: v.optional(v.union(v.number(), v.null())),
    feePerPostingKobo: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    const old = await ctx.db.get(args.tierId);
    if (!old) throw new Error("Tier not found");

    const label = args.label !== undefined ? args.label.trim() : old.label;
    const minEmployees = args.minEmployees ?? old.minEmployees;
    const maxEmployees =
      args.maxEmployees !== undefined ? (args.maxEmployees ?? undefined) : old.maxEmployees;
    const fee = args.feePerPostingKobo ?? old.feePerPostingKobo;
    if (!label) throw new Error("Tier label is required");
    if (!Number.isFinite(minEmployees) || minEmployees < 1) {
      throw new Error("Minimum employees must be at least 1");
    }
    if (maxEmployees !== undefined && maxEmployees < minEmployees) {
      throw new Error("Maximum employees must be >= minimum");
    }
    if (!Number.isFinite(fee) || fee < 0) throw new Error("Fee per posting must be non-negative");

    const changed =
      label !== old.label ||
      minEmployees !== old.minEmployees ||
      maxEmployees !== old.maxEmployees ||
      fee !== old.feePerPostingKobo;
    if (!changed) return { ok: true, unchanged: true };

    const now = Date.now();
    // Overlap guard against OTHER active tiers (any version).
    const activeRows = (await ctx.db.query("pricingTiers").collect()).filter(
      (t) => t.active && t.effectiveFrom <= now && (t.effectiveTo === undefined || t.effectiveTo > now),
    );
    for (const t of activeRows) {
      if (String(t._id) === String(old._id)) continue;
      if (rangesOverlap({ min: minEmployees, max: maxEmployees ?? null }, {
        min: t.minEmployees,
        max: t.maxEmployees ?? null,
      })) {
        throw new Error(`Range overlaps active tier "${t.label}"`);
      }
    }

    // Close the current version and insert the successor.
    await ctx.db.patch(old._id, {
      active: false,
      effectiveTo: now,
      updatedAt: now,
    });
    const newId = await ctx.db.insert("pricingTiers", {
      code: old.code,
      label,
      minEmployees,
      maxEmployees,
      feePerPostingKobo: fee,
      active: old.active,
      effectiveFrom: now,
      createdAt: now,
      createdBy: user.email ?? "admin",
    });
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: "pricing_tier_updated",
      entityType: "pricingTier",
      entityId: old.code,
      field: "feePerPostingKobo",
      before: `₦${(old.feePerPostingKobo / 100).toFixed(2)} (${old.label})`,
      after: `₦${(fee / 100).toFixed(2)} (${label})`,
      details: `Tier "${label}" superseded — new version effective immediately; completed billing records keep their original snapshot`,
    });
    return { ok: true, tierId: newId };
  },
});

/** Activate/deactivate a tier (at least one active tier must remain). */
export const setTierActive = mutation({
  args: { tierId: v.id("pricingTiers"), active: v.boolean() },
  handler: async (ctx, { tierId, active }) => {
    const user = await requireAdmin(ctx);
    const tier = await ctx.db.get(tierId);
    if (!tier) throw new Error("Tier not found");
    if (tier.active === active) return { ok: true, unchanged: true };
    if (!active) {
      const others = (await ctx.db.query("pricingTiers").collect()).filter(
        (t) =>
          t.active &&
          t.code !== tier.code &&
          t.effectiveFrom <= Date.now() &&
          (t.effectiveTo === undefined || t.effectiveTo > Date.now()),
      );
      if (others.length === 0) {
        throw new Error("At least one active pricing tier must remain");
      }
    }
    const now = Date.now();
    await ctx.db.patch(tierId, { active, updatedAt: now, effectiveTo: active ? undefined : now });
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: active ? "pricing_tier_activated" : "pricing_tier_deactivated",
      entityType: "pricingTier",
      entityId: tier.code,
      field: "active",
      before: String(tier.active),
      after: String(active),
      details: `Tier "${tier.label}" ${active ? "activated" : "deactivated"}`,
    });
    return { ok: true };
  },
});

/** Create a subscription plan. */
export const createPlan = mutation({
  args: {
    code: v.string(),
    name: v.string(),
    monthlyPriceKobo: v.number(),
    priceIsFrom: v.boolean(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    await ensurePricingSeeded(ctx);
    const code = args.code.trim().toLowerCase();
    if (!code || !args.name.trim()) throw new Error("Plan code and name are required");
    if (!Number.isFinite(args.monthlyPriceKobo) || args.monthlyPriceKobo < 0) {
      throw new Error("Monthly price must be a non-negative number");
    }
    const existing = (await ctx.db.query("subscriptionPlans").collect()).find((p) => p.code === code);
    if (existing) throw new Error(`A plan with code "${code}" already exists`);
    const now = Date.now();
    const id = await ctx.db.insert("subscriptionPlans", {
      code,
      name: args.name.trim(),
      monthlyPriceKobo: args.monthlyPriceKobo,
      priceIsFrom: args.priceIsFrom,
      description: args.description?.trim(),
      active: true,
      createdAt: now,
      createdBy: user.email ?? "admin",
    });
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: "subscription_plan_created",
      entityType: "subscriptionPlan",
      entityId: code,
      details: `Created plan "${args.name.trim()}" at ₦${(args.monthlyPriceKobo / 100).toLocaleString()}/month${args.priceIsFrom ? " (from price)" : ""}`,
    });
    return { ok: true, planId: id };
  },
});

/** Update a plan (name/price/description) — audited; assignments keep snapshots. */
export const updatePlan = mutation({
  args: {
    planId: v.id("subscriptionPlans"),
    name: v.optional(v.string()),
    monthlyPriceKobo: v.optional(v.number()),
    priceIsFrom: v.optional(v.boolean()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    const plan = await ctx.db.get(args.planId);
    if (!plan) throw new Error("Plan not found");
    const name = args.name !== undefined ? args.name.trim() : plan.name;
    const price = args.monthlyPriceKobo ?? plan.monthlyPriceKobo;
    const isFrom = args.priceIsFrom ?? plan.priceIsFrom;
    const desc = args.description !== undefined ? args.description.trim() : plan.description;
    if (!name) throw new Error("Plan name is required");
    if (!Number.isFinite(price) || price < 0) throw new Error("Monthly price must be non-negative");
    const now = Date.now();
    await ctx.db.patch(args.planId, {
      name,
      monthlyPriceKobo: price,
      priceIsFrom: isFrom,
      description: desc,
      updatedAt: now,
    });
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: "subscription_plan_updated",
      entityType: "subscriptionPlan",
      entityId: plan.code,
      field: "monthlyPriceKobo",
      before: `₦${(plan.monthlyPriceKobo / 100).toLocaleString()}`,
      after: `₦${(price / 100).toLocaleString()}`,
      details: `Plan "${name}" updated — existing assignments keep their snapshot price`,
    });
    return { ok: true };
  },
});

/** Enable/disable a plan for future assignments. */
export const setPlanActive = mutation({
  args: { planId: v.id("subscriptionPlans"), active: v.boolean() },
  handler: async (ctx, { planId: pid, active }) => {
    const user = await requireAdmin(ctx);
    const plan = await ctx.db.get(pid);
    if (!plan) throw new Error("Plan not found");
    if (plan.active === active) return { ok: true, unchanged: true };
    await ctx.db.patch(pid, { active, updatedAt: Date.now() });
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: active ? "subscription_plan_enabled" : "subscription_plan_disabled",
      entityType: "subscriptionPlan",
      entityId: plan.code,
      field: "active",
      before: String(plan.active),
      after: String(active),
      details: `Plan "${plan.name}" ${active ? "enabled" : "disabled"}`,
    });
    return { ok: true };
  },
});

/** Assign (or switch) an employer's platform subscription — explicit, audited. */
export const assignSubscription = mutation({
  args: { employerId: v.id("employers"), planCode: v.string() },
  handler: async (ctx, { employerId, planCode }) => {
    const user = await requireAdmin(ctx);
    const employer = await ctx.db.get(employerId);
    if (!employer) throw new Error("Employer not found");
    const plan = (await ctx.db.query("subscriptionPlans").collect()).find(
      (p) => p.code === planCode && p.active,
    );
    if (!plan) throw new Error("Active plan not found");
    const now = Date.now();
    const subs = await ctx.db
      .query("employerSubscriptions")
      .withIndex("by_employer", (q) => q.eq("employerId", employerId))
      .collect();
    const current = subs.find((s) => s.status === "active");
    if (current) {
      if (current.planCode === plan.code) return { ok: true, unchanged: true };
      await ctx.db.patch(current._id, { status: "cancelled", endedAt: now });
    }
    await ctx.db.insert("employerSubscriptions", {
      employerId,
      planCode: plan.code,
      planName: plan.name,
      monthlyPriceKobo: plan.monthlyPriceKobo, // snapshot at assignment
      status: "active",
      startedAt: now,
      createdAt: now,
      createdBy: user.email ?? "admin",
    });
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: "subscription_assigned",
      entityType: "employer",
      entityId: String(employerId),
      employerId,
      details: `${employer.name} → ${plan.name} at ₦${(plan.monthlyPriceKobo / 100).toLocaleString()}/month`,
    });
    return { ok: true };
  },
});

/** Cancel an employer's subscription (no forced subscription — opt-out works). */
export const cancelSubscription = mutation({
  args: { employerId: v.id("employers") },
  handler: async (ctx, { employerId }) => {
    const user = await requireAdmin(ctx);
    const subs = await ctx.db
      .query("employerSubscriptions")
      .withIndex("by_employer", (q) => q.eq("employerId", employerId))
      .collect();
    const current = subs.find((s) => s.status === "active");
    if (!current) return { ok: true, unchanged: true };
    const now = Date.now();
    await ctx.db.patch(current._id, { status: "cancelled", endedAt: now });
    const employer = await ctx.db.get(employerId);
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: "subscription_cancelled",
      entityType: "employer",
      entityId: String(employerId),
      employerId,
      details: `${employer?.name ?? "Employer"}: ${current.planName} subscription cancelled`,
    });
    return { ok: true };
  },
});

/** Type re-export for consumers that need the stored row shape. */
export type PricingTierRow = Doc<"pricingTiers">;
