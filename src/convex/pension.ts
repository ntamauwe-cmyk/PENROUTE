import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getCurrentUser } from "./users";
import { audit, getCurrentEmployer, getEmployerForUser } from "./employers";
import { applyFlatFeeToActiveTiers, quoteForPostings } from "./pricing";
import { applyPfaSeed, isSelectable } from "./pfaDirectory";
import { bootstrapAdminEmails, requireSandboxMode, sandboxModeEnabled } from "./environment";
import { notify } from "./notifications";
import { TERMS_VERSION } from "../lib/legal";

/** RC number of the seeded demo employer — the ONLY workspace demo-claiming may touch. */
const DEMO_EMPLOYER_RC = "RC-1938476";

// ============================================================================
// PFA DIRECTORY — licensed Pension Fund Administrators in Nigeria
// ----------------------------------------------------------------------------
// Master/reference data lives in pfaDirectory.ts (the current PenCom-
// licensed PFAs, keyed by immutable slug). syncPfaDirectory below keeps its
// historical name/shape for existing UI callers and delegates to the same
// idempotent seeder. Codes are Penroute reference codes for routing/integration
// configuration — they are NOT official PENCOM licence numbers. PFAs default
// to clearly-labelled "Not Integrated" until a live integration is approved.
// ============================================================================

/**
 * Idempotently adopts the full PFA directory (all current licensed PFAs).
 * Safe to call any time — never creates duplicates. Admins only: it updates
 * master data.
 */
export const syncPfaDirectory = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    if (user.role !== "admin") throw new ConvexError("Admin access required");

    const result = await applyPfaSeed(ctx, user.email ?? "admin");
    return { inserted: result.inserted, updated: result.updated, total: result.total };
  },
});

// ============================================================================
// QUERIES — used by the Employer Dashboard (the one screen for the demo)
// ============================================================================

/**
 * The real-time Pension Payment Status screen (spec §41 + Rae's requirements):
 * amount/contributions, contribution month, payment date, status,
 * employees + employee numbers, PFA submission status.
 */
export const getEmployerDashboard = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;

    // PFA-portal users have no employer workspace — they must never receive
    // employer data (including the demo-employer fallback below).
    if (user.role === "pfa") return null;

    // Explicit employer membership only; shared active/demo fallback is unsafe.
    const employer = await getEmployerForUser(ctx, user);
    if (!employer) return null;

    const batches = await ctx.db
      .query("contributionBatches")
      .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
      .take(10_000);

    const employees = await ctx.db
      .query("employees")
      .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
      .take(10_000);

    const openExceptions = await ctx.db
      .query("exceptions")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .filter((q) => q.eq(q.field("employerId"), employer._id))
      .take(10_000);

    const totalProcessed = batches
      .filter((b) => b.status === "completed")
      .reduce((s, b) => s + b.totalPensionAmount, 0);
    const totalFees = batches
      .filter((b) => b.status === "completed")
      .reduce((s, b) => s + b.platformFee, 0);

    return {
      // SECURITY: strip the payroll API key (and its hash) — server-side
      // only, managed (shown once) through Settings → Payroll Integration.
      employer: employer ? { ...employer, apiKey: undefined, apiKeyHash: undefined } : employer,
      batches: batches.sort((a, b) => b.createdAt - a.createdAt),
      employeeCount: employees.length,
      openExceptions: openExceptions.length,
      totalProcessed,
      totalFees,
      stats: {
        completed: batches.filter((b) => b.status === "completed").length,
        processing: batches.filter((b) => ["processing", "awaiting_payment"].includes(b.status)).length,
        failed: batches.filter((b) => b.status === "failed").length,
      },
    };
  },
});

/** Detail for one batch — employer-scoped: a signed-in user can only read
 *  batches belonging to their own employer. */
export const getBatchDetail = query({
  args: { batchId: v.id("contributionBatches") },
  handler: async (ctx, { batchId }) => {
    const user = await getCurrentUser(ctx);
    if (!user || user.role === "pfa") return null;
    const employer = await getCurrentEmployer(ctx);
    if (!employer) return null;
    const batch = await ctx.db.get(batchId);
    if (!batch) return null;
    if (batch.employerId !== employer._id) {
      throw new ConvexError("Not authorized to view this batch");
    }

    const records = await ctx.db
      .query("contributionRecords")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .take(10_000);
    const recordsSorted = records.sort((a, b) => a.fullName.localeCompare(b.fullName));

    const payment = await ctx.db
      .query("payments")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .first();

    const settlements = await ctx.db
      .query("settlements")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .take(10_000);

    const settlementsEnriched = await Promise.all(
      settlements.map(async (s) => {
        const pfa = await ctx.db.get(s.pfaId);
        return {
          ...s,
          pfaName: pfa?.name ?? "Unknown PFA",
          pfaCode: pfa?.code ?? "?",
          // Integration mode of the destination PFA — lets the UI/printouts
          // distinguish simulated sandbox acknowledgements from live confirmations.
          pfaMode: pfa?.integrationMode,
        };
      }),
    );

    const exceptions = await ctx.db
      .query("exceptions")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .take(10_000);

    const pfaAcks = await ctx.db
      .query("pfaAcknowledgements")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .take(10_000);

    return {
      batch,
      records: recordsSorted,
      payment,
      settlements: settlementsEnriched.sort((a, b) => b.amount - a.amount),
      exceptions,
      pfaAcks,
    };
  },
});

/** PFAs directory (public-safe fields only — no credentials). */
export const listPfas = query({
  args: {},
  handler: async (ctx) => {
    const pfas = await ctx.db.query("pfas").collect();
    // SECURITY: endpointConfig holds live integration credentials (server-only).
    // Strip it from every row before returning to any caller.
    return pfas.map((p) => {
      const safe = { ...p };
      delete safe.endpointConfig;
      return safe;
    });
  },
});

/** Contribution records for one PFA (PFA portal employee allocations view).
 *  Authorized callers: administrators, and PFA users for their OWN PFA only —
 *  pfaId is never trusted from the client without this check. */
export const getPfaAllocations = query({
  args: { pfaId: v.id("pfas") },
  handler: async (ctx, { pfaId }) => {
    const caller = await getCurrentUser(ctx);
    if (!caller) throw new ConvexError("Not authenticated");
    if (
      caller.role !== "admin" &&
      (caller.role !== "pfa" || caller.pfaId !== pfaId)
    ) {
      throw new ConvexError("Not authorized to view this PFA's allocations");
    }
    const pfa = await ctx.db.get(pfaId);
    if (!pfa) return null;
    // Integration credentials must remain server-only, including for admins
    // using this client-facing allocations query.
    const safePfa = { ...pfa };
    delete safePfa.endpointConfig;

    const settlements = await ctx.db
      .query("settlements")
      .withIndex("by_pfa", (q) => q.eq("pfaId", pfaId))
      .take(10_000);

    const enriched = await Promise.all(
      settlements.map(async (s) => {
        const batch = await ctx.db.get(s.batchId);
        const employer = batch ? await ctx.db.get(batch.employerId) : null;
        const records = (
          await ctx.db
            .query("contributionRecords")
            .withIndex("by_pfa_batch", (q) => q.eq("pfaId", pfaId).eq("batchId", s.batchId))
            .take(10_000)
        ).sort((a, b) => a.fullName.localeCompare(b.fullName));
        return {
          settlement: s,
          batch,
          employerName: employer?.name ?? "Unknown",
          records,
        };
      }),
    );

    return { pfa: safePfa, groups: enriched };
  },
});

/** Admin: platform-wide numbers. Admins only. */
export const getAdminOverview = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (user?.role !== "admin") throw new ConvexError("Admin access required");

    const [employers, batches, exceptions, ledger, logs] = await Promise.all([
      ctx.db.query("employers").take(10_000),
      ctx.db.query("contributionBatches").take(10_000),
      ctx.db.query("exceptions").withIndex("by_status", (q) => q.eq("status", "open")).take(10_000),
      ctx.db.query("ledgerEntries").take(10_000),
      ctx.db.query("integrationLogs").order("desc").take(20),
    ]);

    const totalPension = batches.reduce((s, b) => s + b.totalPensionAmount, 0);
    const totalFees = batches.reduce((s, b) => s + b.platformFee, 0);

    return {
      employersCount: employers.length,
      batchesCount: batches.length,
      openExceptions: exceptions.length,
      totalPension,
      totalFees,
      recentBatches: batches.sort((a, b) => b.createdAt - a.createdAt).slice(0, 10),
      exceptions,
      ledgerCount: ledger.length,
      recentLogs: logs,
    };
  },
});

/**
 * Legacy compatibility shim — the per-posting rate is derived from the
 * CENTRAL pricing engine (pricing.ts). Kept so older callers keep working;
 * new code should use pricing.getQuote (which also returns the tier).
 */
export const getFeeConfig = query({
  args: {},
  handler: async (ctx) => {
    const quote = await quoteForPostings(ctx, 1);
    return quote.feePerPostingKobo;
  },
});

/** Audit trail for a batch — employer-scoped like getBatchDetail. */
export const getBatchAudit = query({
  args: { batchId: v.id("contributionBatches") },
  handler: async (ctx, { batchId }) => {
    const user = await getCurrentUser(ctx);
    if (!user || user.role === "pfa") return [];
    const employer = await getCurrentEmployer(ctx);
    if (!employer) return [];
    const batch = await ctx.db.get(batchId);
    if (!batch) return [];
    if (batch.employerId !== employer._id) {
      throw new ConvexError("Not authorized to view this batch");
    }
    return (
      await ctx.db
        .query("auditLogs")
        .withIndex("by_batch", (q) => q.eq("batchId", batchId))
        .take(10_000)
    ).sort((a, b) => b.createdAt - a.createdAt);
  },
});

// ============================================================================
// Employer-scoped queries backing the navigation pages (spec §35)
// ============================================================================

/** Payments list for the Transactions page (employer-scoped). */
export const listEmployerPayments = query({
  args: {},
  handler: async (ctx) => {
    const employer = await getCurrentEmployer(ctx);
    if (!employer) return [];
    return (
      await ctx.db
        .query("payments")
        .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
        .take(10_000)
    ).sort((a, b) => b.initiatedAt - a.initiatedAt);
  },
});

/** Double-entry ledger rows for this employer (employer-scoped). */
export const listEmployerLedger = query({
  args: {},
  handler: async (ctx) => {
    const employer = await getCurrentEmployer(ctx);
    if (!employer) return [];
    return (
      await ctx.db
        .query("ledgerEntries")
        .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
        .take(10_000)
    ).sort((a, b) => b.entryDate - a.entryDate);
  },
});

/** Exceptions dashboard (employer-scoped). */
export const listEmployerExceptions = query({
  args: {},
  handler: async (ctx) => {
    const employer = await getCurrentEmployer(ctx);
    if (!employer) return [];
    return (
      await ctx.db
        .query("exceptions")
        .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
        .take(10_000)
    ).sort((a, b) => b.createdAt - a.createdAt);
  },
});

/** Audit trail for the whole employer (employer-scoped). */
export const listEmployerAudit = query({
  args: {},
  handler: async (ctx) => {
    const employer = await getCurrentEmployer(ctx);
    if (!employer) return [];
    return (
      await ctx.db
        .query("auditLogs")
        .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
        .take(10_000)
    ).sort((a, b) => b.createdAt - a.createdAt);
  },
});

/** Employee roster for the Employees page (employer-scoped). */
export const listEmployerEmployees = query({
  args: {},
  handler: async (ctx) => {
    const employer = await getCurrentEmployer(ctx);
    if (!employer) return [];
    const pfas = await ctx.db.query("pfas").collect();
    const pfaById = new Map(pfas.map((p) => [p._id, p]));
    const employees = await ctx.db
      .query("employees")
      .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
      .take(10_000);
    return employees
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
      .map((e) => ({
        _id: e._id,
        employeeCode: e.employeeCode,
        fullName: e.fullName,
        pensionPin: e.pensionPin,
        active: e.active,
        pfaId: e.pfaId,
        pfaName: pfaById.get(e.pfaId)?.name ?? "Unknown PFA",
        pfaCode: pfaById.get(e.pfaId)?.code ?? "?",
        monthlyEmolumentKobo: e.monthlyEmolumentKobo ?? null,
      }));
  },
});

// ============================================================================
// MUTATIONS — onboarding & configuration
// ============================================================================

/** Auto-claim: first signed-in user becomes owner of the demo employer. */
export const claimDemoEmployer = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    if (user.role !== "admin") throw new ConvexError("Demo employer claiming is restricted to platform admins");
    requireSandboxMode("The demo workspace");
    // Only ever the seeded demo employer — never "the first active employer",
    // which on a live deployment is a real customer's workspace.
    const active = await ctx.db
      .query("employers")
      .withIndex("by_rc", (q) => q.eq("rcNumber", DEMO_EMPLOYER_RC))
      .first();
    if (!active) throw new ConvexError("No demo employer seeded yet");
    // Ownership must MOVE with the claim: workspace resolution
    // (getEmployerForUser) only grants access to the employer's owner, so
    // linking the claimer without transferring ownership left them with a
    // dead workspace (dashboard stayed null after a "successful" claim).
    if (active.ownerUserId !== user._id) {
      await ctx.db.patch(active._id, { ownerUserId: user._id });
    }
    if (!user.employerId) {
      await ctx.db.patch(user._id, { employerId: active._id });
    }
    return { employerId: active._id as string, name: active.name };
  },
});

/**
 * ONE-TIME PLATFORM-ADMIN BOOTSTRAP — sign-up creates role-less users and no
 * routine flow ever grants `admin`, which would leave every admin gate (demo
 * loading, the admin console, pricing, fee saves) permanently closed on a
 * fresh deployment. The first signed-in, non-anonymous account may claim the
 * role while NO admin exists; as soon as one does, this door locks forever.
 * Guest/anonymous sessions are never eligible (enforced server-side).
 */
export const bootstrapAdminStatus = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return { available: false, eligible: false };
    if (user.role === "admin") return { available: false, eligible: false };
    const users = await ctx.db.query("users").take(10_000);
    const available = !users.some((u) => u.role === "admin");
    const allowed = bootstrapAdminEmails();
    return {
      available,
      eligible:
        !user.isAnonymous && Boolean(user.email) && allowed.has((user.email ?? "").trim().toLowerCase()),
    };
  },
});

/** Claim platform-admin — succeeds only while no admin exists at all. */
export const claimPlatformAdmin = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    if (user.isAnonymous) throw new ConvexError("Sign in with your email to claim platform admin");
    if (!user.email) throw new ConvexError("A signed-in email account is required to claim platform admin");
    if (user.role === "admin") return { ok: true, unchanged: true };
    // Only operator emails named in PENROUTE_BOOTSTRAP_ADMIN_EMAILS may claim.
    // Without it, the first stranger to sign up on a fresh deployment would
    // become super-admin. (Operators can also grant admin from the CLI:
    // `npx convex run admin:grantPlatformAdmin '{"email":"..."}'`.)
    if (!bootstrapAdminEmails().has(user.email.trim().toLowerCase())) {
      throw new ConvexError("This account is not authorised to claim platform admin");
    }
    const users = await ctx.db.query("users").take(10_000);
    if (users.some((u) => u.role === "admin")) {
      throw new ConvexError("Platform admin is already configured");
    }
    await ctx.db.patch(user._id, { role: "admin" });
    await ctx.db.insert("auditLogs", {
      actor: user.email,
      action: "platform_admin_bootstrapped",
      entityType: "user",
      entityId: user._id,
      details: `${user.email} claimed the one-time platform-admin bootstrap (no admin existed)`,
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * Self-service employer onboarding (spec §4): any signed-in user can register
 * their company and get their own workspace immediately. The new employer
 * becomes the user's active workspace; the demo fallback only applies to
 * users without an employer link.
 */
export const registerEmployer = mutation({
  args: {
    name: v.string(),
    rcNumber: v.string(),
    tin: v.string(),
    registeredAddress: v.string(),
    contactEmail: v.string(),
    contactPhone: v.string(),
    representativeName: v.string(),
    acceptTerms: v.boolean(),
  },
  handler: async (ctx, { acceptTerms, ...args }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    if (!acceptTerms) throw new ConvexError("Accept the Terms of Service and Privacy Notice to register");
    if (user.isAnonymous && !sandboxModeEnabled()) {
      throw new ConvexError("Sign in with your work email to register a company");
    }
    if (user.role === "pfa") throw new ConvexError("PFA portal accounts cannot register an employer workspace");
    if (!args.name.trim()) throw new ConvexError("Company name is required");
    if (!args.rcNumber.trim()) throw new ConvexError("RC number is required");
    if (!args.tin.trim()) throw new ConvexError("TIN is required");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(args.contactEmail.trim())) throw new ConvexError("A valid contact email is required");
    for (const [field, value] of Object.entries(args)) {
      if (value.length > 300) throw new ConvexError(`${field} is too long`);
    }

    const dupRc = await ctx.db
      .query("employers")
      .withIndex("by_rc", (q) => q.eq("rcNumber", args.rcNumber.trim()))
      .first();
    if (dupRc) throw new ConvexError("An employer with this RC number already exists");

    const now = Date.now();
    const employerId = await ctx.db.insert("employers", {
      name: args.name.trim(),
      rcNumber: args.rcNumber.trim(),
      tin: args.tin.trim(),
      registeredAddress: args.registeredAddress.trim() || "—",
      contactEmail: args.contactEmail.trim(),
      contactPhone: args.contactPhone.trim() || "—",
      representativeName: args.representativeName.trim() || (user.name ?? "Admin"),
      status: "pending",
      kycStatus: "pending",
      ownerUserId: user._id,
      termsAcceptedAt: now,
      termsVersion: TERMS_VERSION,
      termsAcceptedBy: user._id,
      createdAt: now,
    });

    // Keep any existing demo employer intact; this user now points at their own.
    await ctx.db.patch(user._id, { employerId });

    await ctx.db.insert("auditLogs", {
      actor: user.email ?? "unknown",
      action: "employer_registered",
      entityType: "employer",
      entityId: employerId,
      employerId,
      details: `${args.name.trim()} (${args.rcNumber.trim()}) onboarded via self-service; accepted terms ${TERMS_VERSION}`,
      createdAt: now,
    });
    await notify(ctx, {
      audience: "admin",
      kind: "employer_application",
      title: `New employer application: ${args.name.trim()}`,
      body: `${args.name.trim()} (${args.rcNumber.trim()}) registered and is awaiting KYB review.`,
      link: "/admin",
    });
    await notify(ctx, {
      audience: "employer",
      employerId,
      kind: "registration_received",
      title: "Registration received",
      body: `Thanks for registering ${args.name.trim()} on Penroute. Upload your company documents in Settings; we'll notify you as soon as your account is approved for contribution payments.`,
      link: "/dashboard/settings",
    });

    return { employerId };
  },
});

export const seedDemoData = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    if (user.role !== "admin") throw new ConvexError("Demo data seeding is restricted to platform admins");
    requireSandboxMode("Demo data seeding");
    const existing = await ctx.db.query("employers").first();
    if (existing) return { seeded: false, reason: "already_seeded" };

    const now = Date.now();
    const employerId = await ctx.db.insert("employers", {
      name: "Rae Technologies Limited",
      rcNumber: "RC-1938476",
      tin: "TIN-22910384-0001",
      registeredAddress: "14 Adeola Odeku Street, Victoria Island, Lagos",
      contactEmail: "pensions@raetechnologies.ng",
      contactPhone: "+234 801 234 5678",
      representativeName: "Rae Admin",
      status: "active",
      kycStatus: "verified",
      ownerUserId: user?._id,
      createdAt: now,
    });

    // Seed the full current licensed PFA directory idempotently (pfaDirectory.ts)
    // — never duplicates existing rows on any deployment.
    await applyPfaSeed(ctx, "system:demo_seed");
    const pfaRows = await ctx.db.query("pfas").collect();
    const pfaIds: Record<string, Id<"pfas">> = {};
    for (const p of pfaRows) {
      if (p.slug) pfaIds[p.slug] = p._id;
    }

    // 24 demo employees across 4 PFAs
    const employeeNames = [
      "Adaeze Okafor", "Chinedu Eze", "Funmi Adeyemi", "Ibrahim Musa",
      "Ngozi Balogun", "Tunde Ogunlesi", "Aisha Bello", "Emeka Nwosu",
      "Yemi Johnson", "Halima Sule", "Kelechi Obi", "Blessing Etim",
      "Damilola Ayo", "Oluwaseun Adesanya", "Zainab Lawal", "Peter Uche",
      "Grace Danjuma", "Segun Adewale", "Amaka Igwe", "Sani Garba",
      "Chiamaka Obi", "Femi Odukoya", "Hauwa Yusuf", "Tope Alabi",
    ];
    const pfaCycle = [
      "access_pensions", "stanbic_ibtc_pensions", "leadway_pensure", "trustfund_pensions",
      "premium_pension", "crusadersterling_pensions", "fcmb_pensions", "fidelity_pension_managers",
    ];
    for (let i = 0; i < employeeNames.length; i++) {
      await ctx.db.insert("employees", {
        employerId,
        employeeCode: `RAE-EMP-${String(i + 1).padStart(3, "0")}`,
        fullName: employeeNames[i],
        pensionPin: `PIN${String(100000 + i * 37)}`,
        pfaId: pfaIds[pfaCycle[i % pfaCycle.length]],
        active: true,
        createdAt: now,
      });
    }

    await ctx.db.patch(employerId, { employeeCount: employeeNames.length });

    // NOTE: processing-fee pricing is centralised in the pricing service
    // (pricing.ts / src/lib/pricing.ts) — no flat-fee key is seeded here.

    await ctx.db.insert("auditLogs", {
      actor: user?.email ?? "system",
      action: "seed_demo_data",
      entityType: "employer",
      entityId: employerId,
      employerId,
      createdAt: now,
    });

    return { seeded: true, employerId };
  },
});

export const updateFeeConfig = mutation({
  args: { perEmployeeFeeKobo: v.number() },
  handler: async (ctx, { perEmployeeFeeKobo }) => {
    const user = await getCurrentUser(ctx);
    if (user?.role !== "admin") {
      throw new ConvexError("Only platform admins can change pricing");
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
    // Keep the Fee Engine and the tiered pricing engine in lockstep — the
    // saved rate must reach every quote/billing surface, not just this key.
    const propagated = await applyFlatFeeToActiveTiers(
      ctx,
      perEmployeeFeeKobo,
      user.email ?? "admin",
    );
    await ctx.db.insert("auditLogs", {
      actor: user?.email ?? "admin",
      action: "update_fee_config",
      entityType: "systemConfig",
      details:
        `per-employee fee set to ${perEmployeeFeeKobo} kobo (previous: ${row?.value ?? "unset"})` +
        (propagated.updated > 0
          ? ` — applied to ${propagated.updated} active pricing tier${propagated.updated === 1 ? "" : "s"}`
          : " — active tiers already carry this rate"),
      createdAt: now,
    });
    return { ok: true, tiersUpdated: propagated.updated };
  },
});

export const resolveException = mutation({
  args: {
    exceptionId: v.id("exceptions"),
    notes: v.string(),
  },
  handler: async (ctx, { exceptionId, notes }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    const exc = await ctx.db.get(exceptionId);
    if (!exc) throw new ConvexError("Exception not found");
    // Employer users may only resolve their own exceptions; admins may resolve any.
    if (user.role !== "admin") {
      const mine = await getEmployerForUser(ctx, user);
      if (!mine || !exc.employerId || mine._id !== exc.employerId) {
        throw new ConvexError("Not authorized to resolve this exception");
      }
    }
    await ctx.db.patch(exceptionId, {
      status: "resolved",
      resolutionNotes: notes,
      resolvedAt: Date.now(),
    });
    await audit(ctx, {
      actor: user.email ?? "unknown",
      action: "resolve_exception",
      entityType: "exception",
      entityId: exceptionId,
      employerId: exc.employerId ?? undefined,
      batchId: exc.batchId ?? undefined,
      details: notes,
    });
    return { ok: true };
  },
});

// ============================================================================
// Employee management (spec §6) — employer users maintain their own roster
// ============================================================================

function emolumentKobo(naira: number | undefined): number | undefined {
  if (naira === undefined) return undefined;
  if (!Number.isFinite(naira) || naira < 0 || naira > 1_000_000_000) {
    throw new ConvexError("Monthly emoluments must be between ₦0 and ₦1,000,000,000");
  }
  return naira === 0 ? undefined : Math.round(naira * 100);
}

export const addEmployee = mutation({
  args: {
    fullName: v.string(),
    employeeCode: v.string(),
    pensionPin: v.string(),
    pfaId: v.id("pfas"),
    monthlyEmolument: v.optional(v.number()), // naira
  },
  handler: async (ctx, { fullName, employeeCode, pensionPin, pfaId, monthlyEmolument }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    const employer = await getEmployerForUser(ctx, user);
    if (!employer) throw new ConvexError("No employer profile — seed or onboard first");

    const cleanPin = pensionPin.trim().toUpperCase().replace(/\s/g, "");
    if (!/^[A-Z0-9]{6,20}$/.test(cleanPin.replace(/-/g, ""))) {
      throw new ConvexError("Invalid pension PIN format (6–20 letters/digits)");
    }
    if (!fullName.trim()) throw new ConvexError("Employee name is required");
    if (!employeeCode.trim()) throw new ConvexError("Employee ID is required");

    const pfa = await ctx.db.get(pfaId);
    if (!pfa) throw new ConvexError("Unknown PFA");
    if (!isSelectable(pfa)) throw new ConvexError(`${pfa.name} is inactive and cannot be selected for new pension records`);

    const dup = await ctx.db
      .query("employees")
      .withIndex("by_employer_pin", (q) =>
        q.eq("employerId", employer._id).eq("pensionPin", cleanPin),
      )
      .first();
    if (dup) throw new ConvexError(`Pension PIN ${cleanPin} already exists for this employer`);

    const now = Date.now();
    const employeeId = await ctx.db.insert("employees", {
      employerId: employer._id,
      employeeCode: employeeCode.trim(),
      fullName: fullName.trim(),
      pensionPin: cleanPin,
      pfaId,
      active: true,
      monthlyEmolumentKobo: emolumentKobo(monthlyEmolument),
      createdAt: now,
    });
    await ctx.db.patch(employer._id, { employeeCount: (employer.employeeCount ?? 0) + 1 });
    await audit(ctx, {
      actor: user.email ?? "unknown",
      action: "employee_added",
      entityType: "employee",
      entityId: employeeId,
      employerId: employer._id,
      details: `${fullName.trim()} (${cleanPin}) → ${pfa.name}`,
    });
    return { employeeId };
  },
});

export const updateEmployee = mutation({
  args: {
    employeeId: v.id("employees"),
    fullName: v.string(),
    employeeCode: v.string(),
    pensionPin: v.string(),
    pfaId: v.id("pfas"),
    monthlyEmolument: v.optional(v.number()), // naira; omit to keep current
  },
  handler: async (ctx, { employeeId, fullName, employeeCode, pensionPin, pfaId, monthlyEmolument }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    const employer = await getEmployerForUser(ctx, user);
    if (!employer) throw new ConvexError("No employer profile");

    const employee = await ctx.db.get(employeeId);
    if (!employee || employee.employerId !== employer._id) {
      throw new ConvexError("Not authorized to modify this employee");
    }

    const cleanPin = pensionPin.trim().toUpperCase().replace(/\s/g, "");
    if (!/^[A-Z0-9]{6,20}$/.test(cleanPin.replace(/-/g, ""))) {
      throw new ConvexError("Invalid pension PIN format (6–20 letters/digits)");
    }
    if (!fullName.trim()) throw new ConvexError("Employee name is required");
    if (!employeeCode.trim()) throw new ConvexError("Employee ID is required");

    const pfa = await ctx.db.get(pfaId);
    if (!pfa) throw new ConvexError("Unknown PFA");
    // Inactive PFAs cannot be chosen for new/changed assignments; keeping an
    // employee on their existing (possibly deactivated) PFA remains allowed so
    // historical records keep resolving.
    if (pfaId !== employee.pfaId && !isSelectable(pfa)) {
      throw new ConvexError(`${pfa.name} is inactive and cannot be selected for new pension records`);
    }

    // Duplicate-PIN check excludes the employee being edited.
    if (cleanPin !== employee.pensionPin) {
      const dup = await ctx.db
        .query("employees")
        .withIndex("by_employer_pin", (q) =>
          q.eq("employerId", employer._id).eq("pensionPin", cleanPin),
        )
        .first();
      if (dup) throw new ConvexError(`Pension PIN ${cleanPin} already exists for this employer`);
    }

    await ctx.db.patch(employeeId, {
      fullName: fullName.trim(),
      employeeCode: employeeCode.trim(),
      pensionPin: cleanPin,
      pfaId,
      ...(monthlyEmolument !== undefined ? { monthlyEmolumentKobo: emolumentKobo(monthlyEmolument) } : {}),
    });
    await audit(ctx, {
      actor: user.email ?? "unknown",
      action: "employee_updated",
      entityType: "employee",
      entityId: employeeId,
      employerId: employer._id,
      details: `${employee.fullName} (${employee.pensionPin}) → ${fullName.trim()} (${cleanPin}), PFA → ${pfa.name}`,
    });
    return { ok: true };
  },
});

export const toggleEmployeeActive = mutation({
  args: { employeeId: v.id("employees") },
  handler: async (ctx, { employeeId }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    const employer = await getEmployerForUser(ctx, user);
    if (!employer) throw new ConvexError("No employer profile");
    const employee = await ctx.db.get(employeeId);
    if (!employee || employee.employerId !== employer._id) {
      throw new ConvexError("Not authorized to modify this employee");
    }
    await ctx.db.patch(employeeId, { active: !employee.active });
    await audit(ctx, {
      actor: user.email ?? "unknown",
      action: employee.active ? "employee_deactivated" : "employee_reactivated",
      entityType: "employee",
      entityId: employeeId,
      employerId: employer._id,
      details: employee.fullName,
    });
    return { ok: true };
  },
});

/** Internal: append to the immutable audit trail. */
export const internalAudit = internalMutation({
  args: {
    actor: v.string(),
    action: v.string(),
    entityType: v.string(),
    entityId: v.optional(v.string()),
    batchId: v.optional(v.id("contributionBatches")),
    details: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("auditLogs", { ...args, createdAt: Date.now() });
  },
});

/** Public deployment flags for the UI (no secrets): whether this is a
 *  sandbox/demo deployment and whether a payment rail is available. */
export const deploymentInfo = query({
  args: {},
  handler: async (ctx) => {
    const rail = await ctx.db
      .query("systemConfig")
      .withIndex("by_key", (q) => q.eq("key", "rail_mode"))
      .first();
    const sandboxMode = sandboxModeEnabled();
    const liveRail = (rail?.value ?? 0) === 1;
    return { sandboxMode, liveRail, paymentsAvailable: liveRail || sandboxMode };
  },
});
