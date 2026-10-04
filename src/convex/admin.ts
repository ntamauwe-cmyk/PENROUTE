import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getCurrentUser } from "./users";
import { internal } from "./_generated/api";
import { audit } from "./employers";
import { randRef } from "../lib/security";
import { applyFlatFeeToActiveTiers, quoteForPostings } from "./pricing";

// ============================================================================
// PLATFORM ADMIN CONSOLE (spec §22, §23) — admins only
// ============================================================================


async function requireAdmin(ctx: Parameters<typeof getCurrentUser>[0]) {
  const user = await getCurrentUser(ctx);
  if (!user) throw new Error("Not authenticated");
  if (user.role !== "admin") throw new Error("Admin access required");
  return user;
}

/** Platform-wide overview: employers, batches, exceptions, fees, rail mode. */
export const getAdminOverview = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const [employers, batches, exceptions, ledger, logs] = await Promise.all([
      ctx.db.query("employers").take(10_000),
      ctx.db.query("contributionBatches").take(10_000),
      ctx.db.query("exceptions").withIndex("by_status", (q) => q.eq("status", "open")).take(10_000),
      ctx.db.query("ledgerEntries").take(10_000),
      ctx.db.query("integrationLogs").order("desc").take(20),
    ]);
    const feeRow = await ctx.db
      .query("systemConfig")
      .withIndex("by_key", (q) => q.eq("key", "per_employee_fee_kobo"))
      .first();
    const railRow = await ctx.db
      .query("systemConfig")
      .withIndex("by_key", (q) => q.eq("key", "rail_mode"))
      .first();
    // The rate quotes/billing actually use — served by the central pricing
    // engine so the console can never display a stale fee.
    const effectiveFeePerEmployeeKobo = (await quoteForPostings(ctx, 1)).feePerPostingKobo;

    const totalPension = batches.reduce((s, b) => s + b.totalPensionAmount, 0);
    const totalFees = batches.reduce((s, b) => s + b.platformFee, 0);

    // PFA statistics — real database values only (no fabricated metrics).
    const [pfas, settlements, records] = await Promise.all([
      ctx.db.query("pfas").collect(),
      ctx.db.query("settlements").take(10_000),
      ctx.db.query("contributionRecords").take(10_000),
    ]);
    const pfasWithTransactions = new Set(settlements.map((s) => String(s.pfaId)));
    for (const r of records) pfasWithTransactions.add(String(r.pfaId));
    const processedEmployees = new Set(records.map((r) => r.pensionPin)).size;
    const pendingRemittances = settlements.filter(
      (s) => s.status === "pending" || s.status === "processing",
    ).length;
    const unreconciled = batches.filter((b) => b.reconciliationStatus !== "reconciled").length;

    return {
      employersCount: employers.length,
      batchesCount: batches.length,
      openExceptions: exceptions.length,
      totalPension,
      totalFees,
      feePerEmployeeKobo: feeRow?.value ?? 900,
      effectiveFeePerEmployeeKobo,
      railMode: (railRow?.value ?? 0) === 1 ? "live" : "sandbox",
      recentBatches: batches.sort((a, b) => b.createdAt - a.createdAt).slice(0, 10),
      exceptions,
      ledgerCount: ledger.length,
      recentLogs: logs,
      pfaStats: {
        activePfas: pfas.filter((p) => p.active !== false && p.status !== "INACTIVE").length,
        totalPfas: pfas.length,
        pfasWithTransactions: pfasWithTransactions.size,
        employeesProcessed: processedEmployees,
        pendingRemittances,
        unreconciledContributions: unreconciled,
      },
    };
  },
});

/** All employers with per-employer stats (admin list view). */
export const listAllEmployers = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const employers = await ctx.db.query("employers").take(10_000);
    const batches = await ctx.db.query("contributionBatches").take(10_000);
    const employees = await ctx.db.query("employees").take(10_000);

    return employers
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((e) => {
        const eb = batches.filter((b) => b.employerId === e._id);
        return {
          _id: e._id,
          name: e.name,
          rcNumber: e.rcNumber,
          status: e.status,
          kycStatus: e.kycStatus,
          contactEmail: e.contactEmail,
          employees: employees.filter((x) => x.employerId === e._id).length,
          batches: eb.length,
          processedKobo: eb
            .filter((b) => b.status === "completed")
            .reduce((s, b) => s + b.totalPensionAmount, 0),
          feesKobo: eb.filter((b) => b.status === "completed").reduce((s, b) => s + b.platformFee, 0),
        };
      });
  },
});

/** All exceptions platform-wide (admin exception dashboard). */
export const listAllExceptions = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const [exceptions, employers] = await Promise.all([
      ctx.db.query("exceptions").take(10_000),
      ctx.db.query("employers").take(10_000),
    ]);
    const nameById = new Map(employers.map((e) => [e._id, e.name]));
    return exceptions
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((e) => ({ ...e, employerName: e.employerId ? nameById.get(e.employerId) ?? "—" : "—" }));
  },
});

/** Update the per-employee processing fee (Fee Engine, spec §23). */
export const adminUpdateFee = mutation({
  args: { perEmployeeFeeKobo: v.number() },
  handler: async (ctx, { perEmployeeFeeKobo }) => {
    const user = await requireAdmin(ctx);
    if (!Number.isFinite(perEmployeeFeeKobo) || perEmployeeFeeKobo < 0) {
      throw new Error("Invalid fee amount");
    }
    const row = await ctx.db
      .query("systemConfig")
      .withIndex("by_key", (q) => q.eq("key", "per_employee_fee_kobo"))
      .first();
    const now = Date.now();
    if (row) {
      await ctx.db.patch(row._id, {
        value: perEmployeeFeeKobo,
        updatedAt: now,
        updatedBy: user.email ?? "admin",
      });
    } else {
      await ctx.db.insert("systemConfig", {
        key: "per_employee_fee_kobo",
        value: perEmployeeFeeKobo,
        updatedAt: now,
        updatedBy: user.email ?? "admin",
      });
    }
    // The Fee Engine must not be a display-only key: propagate the new rate
    // to the live pricing tiers so quotes, billing, revenue reports and the
    // public pricing page all show the price that was just saved.
    const propagated = await applyFlatFeeToActiveTiers(
      ctx,
      perEmployeeFeeKobo,
      user.email ?? "admin",
    );
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: "update_fee_config",
      entityType: "systemConfig",
      details:
        `per-employee fee set to ${perEmployeeFeeKobo} kobo (previous: ${row?.value ?? "unset"})` +
        (propagated.updated > 0
          ? ` — applied to ${propagated.updated} active pricing tier${propagated.updated === 1 ? "" : "s"}`
          : " — active tiers already carry this rate"),
    });
    return { ok: true, tiersUpdated: propagated.updated };
  },
});

/**
 * PLUG-AND-PLAY RAIL SWITCH — flip collection between the sandbox rail and the
 * live Paystack rail. Requires PAYSTACK_SECRET_KEY to be configured before
 * switching to live.
 */
export const adminSetRailMode = mutation({
  args: { mode: v.union(v.literal("sandbox"), v.literal("live")) },
  handler: async (ctx, { mode }) => {
    const user = await requireAdmin(ctx);
    const row = await ctx.db
      .query("systemConfig")
      .withIndex("by_key", (q) => q.eq("key", "rail_mode"))
      .first();
    const now = Date.now();
    const value = mode === "live" ? 1 : 0;
    if (row) {
      await ctx.db.patch(row._id, {
        value,
        updatedAt: now,
        updatedBy: user.email ?? "admin",
      });
    } else {
      await ctx.db.insert("systemConfig", {
        key: "rail_mode",
        value,
        updatedAt: now,
        updatedBy: user.email ?? "admin",
      });
    }
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: "update_rail_mode",
      entityType: "systemConfig",
      details: `payment rail switched to ${mode.toUpperCase()}`,
    });
    return { ok: true };
  },
});

/** Suspend or reactivate an employer (admin KYC/compliance action). */
export const adminSetEmployerStatus = mutation({
  args: {
    employerId: v.id("employers"),
    status: v.union(v.literal("active"), v.literal("suspended")),
  },
  handler: async (ctx, { employerId, status }) => {
    const user = await requireAdmin(ctx);
    const employer = await ctx.db.get(employerId);
    if (!employer) throw new Error("Employer not found");
    await ctx.db.patch(employerId, { status, ...(status === "active" ? { kycStatus: "verified" } : {}) });
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: status === "suspended" ? "employer_suspended" : "employer_reactivated",
      entityType: "employer",
      entityId: employerId,
      employerId,
      details: `${employer.name} → ${status}`,
    });
    return { ok: true };
  },
});

/** Manually retry the pipeline for a stuck batch (failure recovery, spec §40). */
export const adminRetryPipeline = mutation({
  args: { batchId: v.id("contributionBatches") },
  handler: async (ctx, { batchId }) => {
    const user = await requireAdmin(ctx);
    const batch = await ctx.db.get(batchId);
    if (!batch) throw new Error("Batch not found");
    if (batch.status !== "processing") {
      throw new Error(`Only processing batches can be retried (status: ${batch.status})`);
    }
    // Retry through the server-only pipeline; never expose the state machine to clients.
    await ctx.scheduler.runAfter(0, internal.engine.processPipeline, { batchId });
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: "admin_retry_pipeline",
      entityType: "batch",
      employerId: batch.employerId,
      batchId,
      details: `Manual pipeline retry for ${batch.batchRef}`,
    });
    return { ok: true, status: batch.status };
  },
});

export const adminRandRef = randRef;

// ============================================================================
// PFA INTEGRATION CONFIGURATION (spec §11, §13, §38) — plug-and-play live mode
// ============================================================================
// An admin sets a PFA to live_api with its approved endpoint + secret. The
// secret is WRITE-ONLY: it is stored server-side and never returned by any
// query. After configuration, the settlement pipeline delivers contribution
// files to that endpoint automatically (pfaDispatch.ts) — no code changes.

export const adminSetPfaIntegration = mutation({
  args: {
    pfaId: v.id("pfas"),
    integrationMode: v.union(v.literal("sandbox_adapter"), v.literal("live_api"), v.literal("manual")),
    endpoint: v.optional(v.string()),
    apiSecret: v.optional(v.string()),
    secretHeaderName: v.optional(v.string()),
    hmacSecret: v.optional(v.string()),
  },
  handler: async (ctx, { pfaId, integrationMode, endpoint, apiSecret, secretHeaderName, hmacSecret }) => {
    const user = await requireAdmin(ctx);
    const pfa = await ctx.db.get(pfaId);
    if (!pfa) throw new Error("PFA not found");

    if (integrationMode === "live_api") {
      if (!endpoint || !/^https:\/\/.+/.test(endpoint)) {
        throw new Error("live_api requires a valid https:// endpoint");
      }
      if (!apiSecret) {
        const existing = pfa.endpointConfig as { apiSecret?: string } | undefined;
        if (!existing?.apiSecret) throw new Error("live_api requires an API secret (none stored yet)");
      }
    }

    // Merge endpointConfig: keep the stored secret when a new one is not given
    // (write-only secret semantics — the UI never shows or re-sends it).
    const current = (pfa.endpointConfig ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = {
      ...current,
      endpoint: endpoint ?? current.endpoint,
      secretHeaderName: secretHeaderName ?? current.secretHeaderName,
    };
    if (apiSecret !== undefined && apiSecret !== "") next.apiSecret = apiSecret;
    if (hmacSecret !== undefined && hmacSecret !== "") next.hmacSecret = hmacSecret;
    if (integrationMode !== "live_api") {
      delete next.apiSecret;
      delete next.hmacSecret;
    }

    await ctx.db.patch(pfaId, { integrationMode, endpointConfig: next });
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: "update_pfa_integration",
      entityType: "pfa",
      entityId: pfaId,
      details: `${pfa.name} → ${integrationMode}${endpoint ? ` (${endpoint})` : ""}${apiSecret ? " [secret updated]" : ""}`,
    });
    return { ok: true };
  },
});

/** Admin: clear a PFA's stored secrets (e.g. credential rotation / offboarding). */
export const adminClearPfaSecrets = mutation({
  args: { pfaId: v.id("pfas") },
  handler: async (ctx, { pfaId }) => {
    const user = await requireAdmin(ctx);
    const pfa = await ctx.db.get(pfaId);
    if (!pfa) throw new Error("PFA not found");
    const current = (pfa.endpointConfig ?? {}) as Record<string, unknown>;
    const next = { ...current };
    delete next.apiSecret;
    delete next.hmacSecret;
    await ctx.db.patch(pfaId, { endpointConfig: next });
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: "clear_pfa_secrets",
      entityType: "pfa",
      entityId: pfaId,
      details: `${pfa.name}: stored endpoint secrets cleared`,
    });
    return { ok: true };
  },
});

/** Admin list of PFAs with integration state (endpoint yes/no, never secrets). */
export const adminListPfaIntegrations = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const pfas = await ctx.db.query("pfas").collect();
    return pfas
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => {
        const cfg = p.endpointConfig as { endpoint?: string; apiSecret?: string } | undefined;
        return {
          _id: p._id,
          name: p.name,
          code: p.code,
          integrationMode: p.integrationMode,
          hasEndpoint: Boolean(cfg?.endpoint),
          hasSecret: Boolean(cfg?.apiSecret),
          endpoint: cfg?.endpoint ?? null,
        };
      });
  },
});
