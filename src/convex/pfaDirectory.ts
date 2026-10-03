import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser } from "./users";
import { audit, getEmployerForUser } from "./employers";

// ============================================================================
// PFA MASTER DATA — the current licensed PFAs published by PenCom (19).
//
// This is REFERENCE data: presence in Penroute means the PFA is a supported
// selectable pension destination / master record. It does NOT mean the PFA has
// authorised or technically integrated with Penroute. No API endpoints, keys,
// credentials, bank details or contact information are invented here — every
// unverified field stays null until an administrator records verified data.
//
// `slug` is the immutable internal identifier. Never use the display name as a
// primary key. Codes are Penroute reference codes (NOT official PenCom
// numbers); they are deterministic (101–119) so they can never collide with
// legacy rows (001–020) on any deployment.
// ============================================================================

export type PfaSeedEntry = {
  slug: string;
  code: string;
  name: string;
  legalName: string;
  shortName: string;
  /** Legacy/alternate names a deployment may already hold — matched during seeding. */
  aliases: string[];
};

export const PFA_SEED: PfaSeedEntry[] = [
  { slug: "access_pensions", code: "101", name: "Access Pensions Limited", legalName: "Access Pensions Limited", shortName: "Access Pensions", aliases: ["Access ARM Pensions", "ARM Pensions", "Access Pensions"] },
  { slug: "cardinalstone_pensions", code: "102", name: "CardinalStone Pensions Limited", legalName: "CardinalStone Pensions Limited", shortName: "CardinalStone", aliases: ["CardinalStone Pensions"] },
  { slug: "citizens_pensions", code: "103", name: "Citizens Pensions Limited", legalName: "Citizens Pensions Limited", shortName: "Citizens Pensions", aliases: ["Citizens Pensions"] },
  { slug: "crusadersterling_pensions", code: "104", name: "CrusaderSterling Pensions Limited", legalName: "CrusaderSterling Pensions Limited", shortName: "CrusaderSterling", aliases: ["Crusader Sterling Pensions", "CrusaderSterling Pensions"] },
  { slug: "fcmb_pensions", code: "105", name: "FCMB Pensions Limited", legalName: "FCMB Pensions Limited", shortName: "FCMB Pensions", aliases: ["FCMB Pensions"] },
  { slug: "fidelity_pension_managers", code: "106", name: "Fidelity Pension Managers Limited", legalName: "Fidelity Pension Managers Limited", shortName: "Fidelity Pensions", aliases: ["Fidelity Pensions Managers", "Fidelity Pension Managers"] },
  { slug: "gt_pension_managers", code: "107", name: "Guaranty Trust Pension Managers Limited", legalName: "Guaranty Trust Pension Managers Limited", shortName: "Guaranty Trust", aliases: ["Guaranty Trust Pension Managers", "GT Pension Managers"] },
  { slug: "leadway_pensure", code: "108", name: "Leadway Pensure PFA Limited", legalName: "Leadway Pensure PFA Limited", shortName: "Leadway Pensure", aliases: ["Leadway Pensions", "Leadway Pensure PFA"] },
  { slug: "nupemco", code: "109", name: "Nigerian University Pension Management Company (NUPEMCO)", legalName: "Nigerian University Pension Management Company (NUPEMCO)", shortName: "NUPEMCO", aliases: ["NUPEMCO", "Nigerian University Pension Management Company"] },
  { slug: "nlpc_pfa", code: "110", name: "NLPC Pension Fund Administrators Limited", legalName: "NLPC Pension Fund Administrators Limited", shortName: "NLPC PFA", aliases: ["NLPC Pensions", "NLPC Pension Fund Administrators"] },
  { slug: "norrenberger_pensions", code: "111", name: "Norrenberger Pensions Limited", legalName: "Norrenberger Pensions Limited", shortName: "Norrenberger", aliases: ["Norrenberger Pensions"] },
  { slug: "npf_pensions", code: "112", name: "NPF Pensions Limited", legalName: "NPF Pensions Limited", shortName: "NPF Pensions", aliases: ["Nigeria Police Pensions", "NPF Pensions"] },
  { slug: "oak_pensions", code: "113", name: "OAK Pensions Limited", legalName: "OAK Pensions Limited", shortName: "OAK Pensions", aliases: ["OAK Pensions"] },
  { slug: "parthian_pensions", code: "114", name: "Parthian Pensions Limited", legalName: "Parthian Pensions Limited", shortName: "Parthian Pensions", aliases: ["Parthian Pensions"] },
  { slug: "premium_pension", code: "115", name: "Premium Pension Limited", legalName: "Premium Pension Limited", shortName: "Premium Pension", aliases: ["Premium Pensions"] },
  { slug: "stanbic_ibtc_pensions", code: "116", name: "Stanbic IBTC Pension Managers Limited", legalName: "Stanbic IBTC Pension Managers Limited", shortName: "Stanbic IBTC", aliases: ["Stanbic IBTC Pension Managers"] },
  { slug: "tangerine_apt", code: "117", name: "Tangerine APT Pensions Limited", legalName: "Tangerine APT Pensions Limited", shortName: "Tangerine APT", aliases: ["Tangerine A&G Pensions", "Apt Pensions", "Tangerine APT Pensions"] },
  { slug: "trustfund_pensions", code: "118", name: "Trustfund Pensions Limited", legalName: "Trustfund Pensions Limited", shortName: "Trustfund Pensions", aliases: ["Trustfund Pensions"] },
  { slug: "veritas_glanvills", code: "119", name: "Veritas Glanvills Pensions Limited", legalName: "Veritas Glanvills Pensions Limited", shortName: "Veritas Glanvills", aliases: ["Veritas Glanvills Pensions"] },
];

export const INTEGRATION_STATUSES = ["not_integrated", "sandbox", "pending_approval", "production"] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const INTEGRATION_STATUS_LABELS: Record<IntegrationStatus, string> = {
  not_integrated: "Not Integrated",
  sandbox: "Sandbox",
  pending_approval: "Pending Approval",
  production: "Production",
};

/** A PFA may be selected for NEW pension activity only while it is active. */
export function isSelectable(pfa: Doc<"pfas">): boolean {
  return pfa.active !== false && pfa.status !== "INACTIVE";
}

export function integrationStatusLabel(status: string | undefined): string {
  return INTEGRATION_STATUS_LABELS[(status ?? "not_integrated") as IntegrationStatus] ?? "Not Integrated";
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function requireAdmin(ctx: QueryCtx | MutationCtx) {
  const user = await getCurrentUser(ctx);
  if (!user) throw new Error("Not authenticated");
  if (user.role !== "admin") throw new Error("Admin access required");
  return user;
}

// ============================================================================
// SEED — idempotent. Safe to run any number of times: existing rows are
// adopted by slug → code → normalized name/alias, never duplicated. Legacy
// rows that no longer correspond to a current licensed PFA are soft-deactivated
// (never deleted, so historical FK references keep resolving).
// ============================================================================

export async function applyPfaSeed(
  ctx: MutationCtx,
  actor: string,
): Promise<{ inserted: number; updated: number; deactivated: number; total: number }> {
  const now = Date.now();
  const all = await ctx.db.query("pfas").collect();
  const bySlug = new Map(all.filter((p) => p.slug).map((p) => [p.slug as string, p]));
  const byCode = new Map(all.map((p) => [p.code, p]));
  const byNormName = new Map<string, Doc<"pfas">>();
  for (const p of all) {
    for (const candidate of [p.name, p.shortName ?? "", p.legalName ?? ""]) {
      const n = norm(candidate);
      if (n && !byNormName.has(n)) byNormName.set(n, p);
    }
  }

  const matchedIds = new Set<string>();
  let inserted = 0;
  let updated = 0;

  for (const seed of PFA_SEED) {
    const names = [seed.name, seed.shortName, seed.legalName, ...seed.aliases].map(norm);
    const existing =
      bySlug.get(seed.slug) ??
      byCode.get(seed.code) ??
      names.map((n) => byNormName.get(n)).find((p) => p !== undefined);

    if (existing) {
      matchedIds.add(existing._id);
      const patch: Partial<Doc<"pfas">> = {
        slug: seed.slug,
        code: seed.code,
        name: seed.name,
        legalName: seed.legalName,
        shortName: seed.shortName,
        pencomStatus: "LICENSED",
        status: "ACTIVE",
        active: true,
        integrationStatus: existing.integrationStatus ?? "not_integrated",
        updatedAt: now,
      };
      // Never clobber administrator-recorded verified metadata; fill only when absent.
      patch.websiteUrl = existing.websiteUrl ?? undefined;
      patch.supportEmail = existing.supportEmail ?? undefined;
      patch.supportPhone = existing.supportPhone ?? undefined;
      patch.headquartersAddress = existing.headquartersAddress ?? undefined;
      patch.logoUrl = existing.logoUrl ?? undefined;

      const changed =
        existing.name !== patch.name ||
        existing.code !== patch.code ||
        existing.slug !== patch.slug ||
        existing.pencomStatus !== patch.pencomStatus ||
        existing.status !== patch.status ||
        existing.active !== true ||
        existing.integrationStatus === undefined;
      if (changed) {
        await ctx.db.patch(existing._id, patch);
        updated++;
      }
    } else {
      await ctx.db.insert("pfas", {
        name: seed.name,
        code: seed.code,
        slug: seed.slug,
        legalName: seed.legalName,
        shortName: seed.shortName,
        pencomStatus: "LICENSED",
        status: "ACTIVE",
        integrationStatus: "not_integrated",
        integrationMode: "sandbox_adapter",
        active: true,
        createdAt: now,
        updatedAt: now,
      });
      inserted++;
    }
  }

  // Soft-deactivate leftovers (pre-consolidation legacy rows) — preserved for
  // historical references, excluded from selection.
  let deactivated = 0;
  for (const p of all) {
    if (matchedIds.has(p._id)) continue;
    if (p.active === false && p.status === "INACTIVE") continue;
    await ctx.db.patch(p._id, { active: false, status: "INACTIVE", updatedAt: now });
    deactivated++;
  }

  if (inserted > 0 || updated > 0 || deactivated > 0) {
    await audit(ctx, {
      actor,
      action: "seed_pfa_directory",
      entityType: "pfa",
      details: `PFA master seed: ${inserted} inserted, ${updated} adopted/updated, ${deactivated} legacy deactivated — ${PFA_SEED.length} current licensed PFAs`,
      after: String(PFA_SEED.length),
    });
  }
  return { inserted, updated, deactivated, total: PFA_SEED.length };
}

/** CLI migration entry point: `bun convex run pfaDirectory:seedDirectory` */
export const seedDirectory = internalMutation({
  args: {},
  handler: async (ctx) => applyPfaSeed(ctx, "system:pfa_seed"),
});

/**
 * Data-integrity check: `bun convex run pfaDirectory:verifyIntegrity`.
 * Confirms referential integrity of every PFA reference, uniqueness of the
 * master records, and that exactly the 19 seeded PFAs are active.
 */
export const verifyIntegrity = internalQuery({
  args: {},
  handler: async (ctx) => {
    const pfas = await ctx.db.query("pfas").collect();
    const employees = await ctx.db.query("employees").collect();
    const records = await ctx.db.query("contributionRecords").collect();
    const settlements = await ctx.db.query("settlements").collect();

    const orphaned = async (refs: { pfaId: Id<"pfas"> }[]) => {
      let count = 0;
      for (const r of refs) if (!(await ctx.db.get(r.pfaId))) count++;
      return count;
    };

    const active = pfas.filter((p) => p.active !== false && p.status !== "INACTIVE");
    const names = active.map((p) => p.name);
    const slugs = active.map((p) => p.slug);

    return {
      totalPfas: pfas.length,
      activePfas: active.length,
      seededActive: active.filter((p) => p.pencomStatus === "LICENSED").length,
      inactiveLegacy: pfas.length - active.length,
      duplicateActiveNames: names.length - new Set(names).size,
      duplicateSlugs: slugs.filter(Boolean).length - new Set(slugs.filter(Boolean)).size,
      allNotIntegrated: active.every(
        (p) => (p.integrationStatus ?? "not_integrated") === "not_integrated",
      ),
      employeeRefs: employees.length,
      orphanedEmployeeRefs: await orphaned(employees),
      recordRefs: records.length,
      orphanedRecordRefs: await orphaned(records),
      settlementRefs: settlements.length,
      orphanedSettlementRefs: await orphaned(settlements),
    };
  },
});

// ============================================================================
// QUERIES
// ============================================================================

type RowStats = {
  employeesCount: number;
  employersCount: number;
  totalContributed: number; // kobo
  recordCount: number;
  lastContributionAt: number | null;
  settlementCount: number;
  lastSettlementAt: number | null;
};

async function statsForPfa(
  ctx: QueryCtx,
  pfaId: Id<"pfas">,
  scope: { employerId?: Id<"employers"> },
): Promise<RowStats> {
  const employees = await ctx.db
    .query("employees")
    .withIndex("by_pfa", (q) => q.eq("pfaId", pfaId))
    .collect();
  const records = await ctx.db
    .query("contributionRecords")
    .withIndex("by_pfa", (q) => q.eq("pfaId", pfaId))
    .collect();
  const settlements = await ctx.db
    .query("settlements")
    .withIndex("by_pfa", (q) => q.eq("pfaId", pfaId))
    .collect();

  const emp = scope.employerId ? employees.filter((e) => e.employerId === scope.employerId) : employees;
  const rec = scope.employerId ? records.filter((r) => r.employerId === scope.employerId) : records;

  const employerIds = new Set(emp.map((e) => String(e.employerId)));
  return {
    employeesCount: emp.length,
    employersCount: employerIds.size,
    totalContributed: rec.reduce((s, r) => s + r.totalAmount, 0),
    recordCount: rec.length,
    lastContributionAt: rec.length ? Math.max(...rec.map((r) => r.createdAt)) : null,
    settlementCount: settlements.length,
    lastSettlementAt: settlements.length ? Math.max(...settlements.map((s) => s.instructedAt)) : null,
  };
}

/** Safe projection — never includes endpointConfig (secrets are server-only). */
function safePfa(p: Doc<"pfas">, isAdmin: boolean) {
  const cfg = p.endpointConfig as { endpoint?: string } | undefined;
  return {
    _id: p._id,
    name: p.name,
    code: p.code,
    slug: p.slug ?? null,
    legalName: p.legalName ?? null,
    shortName: p.shortName ?? null,
    pencomStatus: p.pencomStatus ?? null,
    status: p.status ?? (p.active ? "ACTIVE" : "INACTIVE"),
    active: p.active,
    integrationStatus: p.integrationStatus ?? "not_integrated",
    integrationStatusLabel: integrationStatusLabel(p.integrationStatus),
    integrationMode: p.integrationMode,
    logoUrl: p.logoUrl ?? null,
    websiteUrl: p.websiteUrl ?? null,
    supportEmail: p.supportEmail ?? null,
    supportPhone: p.supportPhone ?? null,
    headquartersAddress: p.headquartersAddress ?? null,
    hasEndpoint: isAdmin ? Boolean(cfg?.endpoint) : false,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt ?? null,
  };
}

/**
 * PFA directory with real per-PFA statistics. Role-aware:
 * admin → platform-wide numbers; employer → scoped to their own activity.
 * The directory itself is reference data and is visible to any signed-in user.
 */
export const getDirectory = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const isAdmin = user.role === "admin";
    const employer = isAdmin ? null : await getEmployerForUser(ctx, user);
    const scope = isAdmin ? {} : employer ? { employerId: employer._id } : {};

    const pfas = await ctx.db.query("pfas").collect();
    const rows = await Promise.all(
      pfas.map(async (p) => ({
        ...safePfa(p, isAdmin),
        stats: await statsForPfa(ctx, p._id, scope),
      })),
    );
    rows.sort((a, b) => a.name.localeCompare(b.name));

    const totals = {
      total: rows.length,
      active: rows.filter((r) => r.active && r.status !== "INACTIVE").length,
      inactive: rows.filter((r) => !r.active || r.status === "INACTIVE").length,
      licensed: rows.filter((r) => r.pencomStatus === "LICENSED").length,
      notIntegrated: rows.filter((r) => (r.integrationStatus ?? "not_integrated") === "not_integrated").length,
      employeesCovered: rows.reduce((s, r) => s + r.stats.employersCount, 0) > 0 ? rows.reduce((s, r) => s + r.stats.employeesCount, 0) : 0,
      totalContributed: rows.reduce((s, r) => s + r.stats.totalContributed, 0),
      pfasWithTransactions: rows.filter((r) => r.stats.recordCount > 0 || r.stats.settlementCount > 0).length,
    };

    return { isAdmin, rows, totals, syncable: isAdmin };
  },
});

/**
 * Full PFA detail page payload — administrators only (cross-employer activity).
 * Never returns secrets; integration config is reduced to presence flags.
 */
export const getDetail = query({
  args: { pfaId: v.id("pfas") },
  handler: async (ctx, { pfaId }) => {
    await requireAdmin(ctx);
    const pfa = await ctx.db.get(pfaId);
    if (!pfa) return null;

    const stats = await statsForPfa(ctx, pfaId, {});
    const employees = await ctx.db
      .query("employees")
      .withIndex("by_pfa", (q) => q.eq("pfaId", pfaId))
      .collect();

    // Employers using this PFA (with per-employer head counts).
    const employerCountMap = new Map<string, number>();
    for (const e of employees) {
      const k = String(e.employerId);
      employerCountMap.set(k, (employerCountMap.get(k) ?? 0) + 1);
    }
    const employers = (
      await Promise.all([...employerCountMap.entries()].map(async ([id, count]) => {
        const emp = await ctx.db.get(id as Id<"employers">);
        return emp ? { employerId: emp._id, name: emp.name, status: emp.status, employeesCount: count } : null;
      }))
    ).filter((x): x is NonNullable<typeof x> => x !== null);
    employers.sort((a, b) => b.employeesCount - a.employeesCount);

    // Transaction history — settlement instructions (real backend state only).
    const settlements = (
      await ctx.db
        .query("settlements")
        .withIndex("by_pfa", (q) => q.eq("pfaId", pfaId))
        .collect()
    ).sort((a, b) => b.instructedAt - a.instructedAt);
    const transactionHistory = (
      await Promise.all(
        settlements.map(async (s) => {
          const batch = await ctx.db.get(s.batchId);
          const employer = batch ? await ctx.db.get(batch.employerId) : null;
          return {
            settlementId: s._id,
            settlementRef: s.settlementRef,
            amount: s.amount,
            employeeCount: s.employeeCount,
            status: s.status,
            instructedAt: s.instructedAt,
            confirmedAt: s.confirmedAt ?? null,
            batchRef: batch?.batchRef ?? "—",
            period: batch ? `${batch.contributionYear}-${String(batch.contributionMonth).padStart(2, "0")}` : "—",
            employerName: employer?.name ?? "Unknown",
          };
        }),
      )
    ).slice(0, 100);

    // Reconciliation history — PFA payable ledger entries for this PFA.
    const ledger = (
      await ctx.db
        .query("ledgerEntries")
        .withIndex("by_pfa", (q) => q.eq("pfaId", pfaId))
        .collect()
    ).sort((a, b) => b.entryDate - a.entryDate);
    const reconciliationHistory = ledger.slice(0, 100).map((l) => ({
      entryRef: l.entryRef,
      narration: l.narration,
      amount: l.credit || l.debit,
      reconciliationStatus: l.reconciliationStatus,
      entryDate: l.entryDate,
      batchId: l.batchId ?? null,
    }));

    // Exceptions attributed to this PFA.
    const exceptions = (
      await ctx.db
        .query("exceptions")
        .withIndex("by_pfa", (q) => q.eq("pfaId", pfaId))
        .collect()
    ).sort((a, b) => b.createdAt - a.createdAt);

    const cfg = pfa.endpointConfig as { endpoint?: string; apiSecret?: string; hmacSecret?: string } | undefined;

    return {
      pfa: safePfa(pfa, true),
      stats,
      employers,
      transactionHistory,
      reconciliationHistory,
      exceptions: exceptions.slice(0, 50),
      integration: {
        mode: pfa.integrationMode,
        status: pfa.integrationStatus ?? "not_integrated",
        statusLabel: integrationStatusLabel(pfa.integrationStatus),
        endpoint: cfg?.endpoint ?? null,
        hasSecret: Boolean(cfg?.apiSecret || cfg?.hmacSecret),
        // Secrets are NEVER returned — write-only by design.
      },
    };
  },
});

/**
 * PFA report rows: contributions, employees, employers and remittance /
 * reconciliation outcomes per PFA. Admin → platform-wide; employer → scoped.
 * Also returns batchRefs per PFA so reports can filter batches by PFA.
 */
export const getPfaReports = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const isAdmin = user.role === "admin";
    const employer = isAdmin ? null : await getEmployerForUser(ctx, user);

    const pfas = (await ctx.db.query("pfas").collect()).sort((a, b) => a.name.localeCompare(b.name));

    const employees = isAdmin
      ? await ctx.db.query("employees").collect()
      : employer
        ? await ctx.db
            .query("employees")
            .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
            .collect()
        : [];
    const records = isAdmin
      ? await ctx.db.query("contributionRecords").collect()
      : employer
        ? await ctx.db
            .query("contributionRecords")
            .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
            .collect()
        : [];
    const batches = isAdmin
      ? await ctx.db.query("contributionBatches").collect()
      : employer
        ? await ctx.db
            .query("contributionBatches")
            .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
            .collect()
        : [];
    const batchIds = new Set(batches.map((b) => String(b._id)));

    const settlements = (await ctx.db.query("settlements").collect()).filter((s) =>
      isAdmin ? true : batchIds.has(String(s.batchId)),
    );
    const ledger = (await ctx.db.query("ledgerEntries").collect()).filter((l) =>
      isAdmin ? true : l.batchId ? batchIds.has(String(l.batchId)) : false,
    );

    const rows = pfas.map((p) => {
      const emp = employees.filter((e) => e.pfaId === p._id);
      const rec = records.filter((r) => r.pfaId === p._id);
      const stl = settlements.filter((s) => s.pfaId === p._id);
      const led = ledger.filter((l) => l.pfaId === p._id && l.account === "pfa_payable");

      const settled = stl.filter((s) => s.status === "settled");
      const pending = stl.filter((s) => s.status === "pending" || s.status === "processing");
      const failed = stl.filter((s) => s.status === "failed");
      const reconciled = led.filter((l) => l.reconciliationStatus === "reconciled");
      const unreconciled = led.filter((l) => l.reconciliationStatus !== "reconciled");

      const batchRefSet = new Set<string>();
      for (const r of rec) {
        const b = batches.find((x) => x._id === r.batchId);
        if (b) batchRefSet.add(b.batchRef);
      }

      return {
        pfaId: p._id,
        name: p.name,
        shortName: p.shortName ?? null,
        code: p.code,
        slug: p.slug ?? null,
        active: p.active && p.status !== "INACTIVE",
        integrationStatus: p.integrationStatus ?? "not_integrated",
        integrationStatusLabel: integrationStatusLabel(p.integrationStatus),
        employeesCount: emp.length,
        employersCount: isAdmin ? new Set(emp.map((e) => String(e.employerId))).size : null,
        totalEmployeeContribution: rec.reduce((s, r) => s + r.employeeContribution, 0),
        totalEmployerContribution: rec.reduce((s, r) => s + r.employerContribution, 0),
        totalContribution: rec.reduce((s, r) => s + r.totalAmount, 0),
        contributionCount: rec.length,
        remittedAmount: settled.reduce((s, x) => s + x.amount, 0),
        remittedCount: settled.length,
        pendingAmount: pending.reduce((s, x) => s + x.amount, 0),
        pendingCount: pending.length,
        failedAmount: failed.reduce((s, x) => s + x.amount, 0),
        failedCount: failed.length,
        reconciledAmount: reconciled.reduce((s, x) => s + (x.credit || x.debit), 0),
        unreconciledAmount: unreconciled.reduce((s, x) => s + (x.credit || x.debit), 0),
        lastContributionAt: rec.length ? Math.max(...rec.map((r) => r.createdAt)) : null,
        batchRefs: [...batchRefSet],
      };
    });

    return { isAdmin, rows };
  },
});

// ============================================================================
// ADMIN MUTATIONS — only administrators may change PFA master records.
// Every change is audited (administrator, action, PFA, previous/new value).
// Deletion is intentionally NOT offered: soft deactivation only.
// ============================================================================

export const setPfaStatus = mutation({
  args: { pfaId: v.id("pfas"), active: v.boolean() },
  handler: async (ctx, { pfaId, active }) => {
    const user = await requireAdmin(ctx);
    const pfa = await ctx.db.get(pfaId);
    if (!pfa) throw new Error("PFA not found");

    const before = pfa.active && pfa.status !== "INACTIVE" ? "ACTIVE" : "INACTIVE";
    const after = active ? "ACTIVE" : "INACTIVE";
    if (before === after) return { ok: true, unchanged: true };

    await ctx.db.patch(pfaId, {
      active,
      status: after,
      updatedAt: Date.now(),
    });
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: active ? "pfa_activated" : "pfa_deactivated",
      entityType: "pfa",
      entityId: pfaId,
      field: "status",
      before,
      after,
      details: `${pfa.name}: ${before} → ${after}${active ? "" : " (soft deactivation — historical transactions preserved)"}`,
    });
    return { ok: true, status: after };
  },
});

export const updatePfaMetadata = mutation({
  args: {
    pfaId: v.id("pfas"),
    legalName: v.optional(v.string()),
    shortName: v.optional(v.string()),
    websiteUrl: v.optional(v.string()),
    supportEmail: v.optional(v.string()),
    supportPhone: v.optional(v.string()),
    headquartersAddress: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    const pfa = await ctx.db.get(args.pfaId);
    if (!pfa) throw new Error("PFA not found");

    const trimOrUndefined = (s: string | undefined): string | undefined => {
      const t = s?.trim();
      return t ? t : undefined;
    };

    const website = trimOrUndefined(args.websiteUrl);
    if (website && !/^https?:\/\/[^\s]+$/i.test(website)) {
      throw new Error("Website must be a valid http(s) URL");
    }
    const email = trimOrUndefined(args.supportEmail);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Support email is not a valid email address");
    }
    const phone = trimOrUndefined(args.supportPhone);
    if (phone && !/^[+0-9()\-\s]{5,20}$/.test(phone)) {
      throw new Error("Support phone contains invalid characters");
    }
    const shortName = trimOrUndefined(args.shortName);
    if (shortName && shortName.length > 40) throw new Error("Short name is too long (max 40)");
    const legalName = trimOrUndefined(args.legalName);
    if (legalName && legalName.length > 200) throw new Error("Legal name is too long (max 200)");
    const address = trimOrUndefined(args.headquartersAddress);
    if (address && address.length > 300) throw new Error("Address is too long (max 300)");

    type EditableField =
      | "legalName"
      | "shortName"
      | "websiteUrl"
      | "supportEmail"
      | "supportPhone"
      | "headquartersAddress";
    const proposed: Record<EditableField, string | undefined> = {
      legalName,
      shortName,
      websiteUrl: website,
      supportEmail: email,
      supportPhone: phone,
      headquartersAddress: address,
    };

    const patch: Partial<Doc<"pfas">> = {};
    let changes = 0;
    for (const field of Object.keys(proposed) as EditableField[]) {
      const next = proposed[field];
      const prev = pfa[field] ?? undefined;
      if (prev === next) continue;
      patch[field] = next;
      changes++;
      await audit(ctx, {
        actor: user.email ?? "admin",
        action: "pfa_metadata_updated",
        entityType: "pfa",
        entityId: args.pfaId,
        field,
        before: prev ?? "(empty)",
        after: next ?? "(empty)",
        details: `${pfa.name}: ${field} "${prev ?? "(empty)"}" → "${next ?? "(empty)"}"`,
      });
    }
    if (changes === 0) return { ok: true, changed: 0 };

    patch.updatedAt = Date.now();
    await ctx.db.patch(args.pfaId, patch);
    return { ok: true, changed: changes };
  },
});

/**
 * Manually record the integration status for a PFA. This only stores the
 * administrative state — it does NOT create, simulate or imply any technical
 * integration. Default remains "not_integrated" unless explicitly configured.
 */
export const setIntegrationStatus = mutation({
  args: {
    pfaId: v.id("pfas"),
    integrationStatus: v.union(
      v.literal("not_integrated"),
      v.literal("sandbox"),
      v.literal("pending_approval"),
      v.literal("production"),
    ),
  },
  handler: async (ctx, { pfaId, integrationStatus }) => {
    const user = await requireAdmin(ctx);
    const pfa = await ctx.db.get(pfaId);
    if (!pfa) throw new Error("PFA not found");
    const before = pfa.integrationStatus ?? "not_integrated";
    if (before === integrationStatus) return { ok: true, unchanged: true };

    await ctx.db.patch(pfaId, { integrationStatus, updatedAt: Date.now() });
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: "pfa_integration_status_changed",
      entityType: "pfa",
      entityId: pfaId,
      field: "integrationStatus",
      before: integrationStatusLabel(before),
      after: integrationStatusLabel(integrationStatus),
      details: `${pfa.name}: integration status ${integrationStatusLabel(before)} → ${integrationStatusLabel(integrationStatus)}`,
    });
    return { ok: true, status: integrationStatus };
  },
});
