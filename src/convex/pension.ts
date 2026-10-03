import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getCurrentUser } from "./users";
import { audit, getCurrentEmployer, getEmployerForUser } from "./employers";
import { PFA_SEED, applyPfaSeed, isSelectable } from "./pfaDirectory";

// ============================================================================
// PFA DIRECTORY — licensed Pension Fund Administrators in Nigeria
// ----------------------------------------------------------------------------
// Master/reference data lives in pfaDirectory.ts (the 19 current PenCom-
// licensed PFAs, keyed by immutable slug). syncPfaDirectory below keeps its
// historical name/shape for existing UI callers and delegates to the same
// idempotent seeder. Codes are Penroute reference codes for routing/integration
// configuration — they are NOT official PENCOM licence numbers. PFAs default
// to clearly-labelled "Not Integrated" until a live integration is approved.
// ============================================================================

/**
 * Idempotently adopts the full PFA directory (19 current licensed PFAs).
 * Safe to call any time — never creates duplicates. Admins only: it updates
 * master data.
 */
export const syncPfaDirectory = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    if (user.role !== "admin") throw new Error("Admin access required");

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

    // Employer resolution: user link first, then owner match.
    // Auto-claim of the demo employer happens in claimDemoEmployer (queries cannot mutate).
    let employer = user.employerId
      ? await ctx.db.get(user.employerId)
      : await ctx.db
          .query("employers")
          .withIndex("by_owner", (q) => q.eq("ownerUserId", user._id))
          .first();

    if (!employer) {
      employer =
        (await ctx.db
          .query("employers")
          .withIndex("by_status", (q) => q.eq("status", "active"))
          .first()) ?? null;
    }
    if (!employer) return null;

    const batches = await ctx.db
      .query("contributionBatches")
      .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
      .collect();

    const employees = await ctx.db
      .query("employees")
      .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
      .collect();

    const openExceptions = await ctx.db
      .query("exceptions")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .filter((q) => q.eq(q.field("employerId"), employer._id))
      .collect();

    const totalProcessed = batches
      .filter((b) => b.status === "completed")
      .reduce((s, b) => s + b.totalPensionAmount, 0);
    const totalFees = batches
      .filter((b) => b.status === "completed")
      .reduce((s, b) => s + b.platformFee, 0);

    return {
      // SECURITY: strip the payroll API key — it is server-side only and is
      // managed (shown once) through Settings → Payroll Integration.
      employer: employer ? { ...employer, apiKey: undefined } : employer,
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
    const employer = await getCurrentEmployer(ctx);
    const batch = await ctx.db.get(batchId);
    if (!batch) return null;
    // Auth: batch must belong to the caller's employer (or be public demo data
    // pre-claim — only when no employer profile exists yet).
    if (employer && batch.employerId !== employer._id) {
      throw new Error("Not authorized to view this batch");
    }

    const records = await ctx.db
      .query("contributionRecords")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .collect();
    const recordsSorted = records.sort((a, b) => a.fullName.localeCompare(b.fullName));

    const payment = await ctx.db
      .query("payments")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .first();

    const settlements = await ctx.db
      .query("settlements")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .collect();

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
      .collect();

    const pfaAcks = await ctx.db
      .query("pfaAcknowledgements")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .collect();

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
    return pfas.map(({ endpointConfig, ...safe }) => safe);
  },
});

/** Contribution records for one PFA (PFA portal employee allocations view). */
export const getPfaAllocations = query({
  args: { pfaId: v.id("pfas") },
  handler: async (ctx, { pfaId }) => {
    const pfa = await ctx.db.get(pfaId);
    if (!pfa) return null;

    const settlements = await ctx.db
      .query("settlements")
      .withIndex("by_pfa", (q) => q.eq("pfaId", pfaId))
      .collect();

    const enriched = await Promise.all(
      settlements.map(async (s) => {
        const batch = await ctx.db.get(s.batchId);
        const employer = batch ? await ctx.db.get(batch.employerId) : null;
        const records = (
          await ctx.db
            .query("contributionRecords")
            .withIndex("by_pfa_batch", (q) => q.eq("pfaId", pfaId).eq("batchId", s.batchId))
            .collect()
        ).sort((a, b) => a.fullName.localeCompare(b.fullName));
        return {
          settlement: s,
          batch,
          employerName: employer?.name ?? "Unknown",
          records,
        };
      }),
    );

    return { pfa, groups: enriched };
  },
});

/** Admin: platform-wide numbers. Admins only. */
export const getAdminOverview = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (user?.role !== "admin") throw new Error("Admin access required");

    const [employers, batches, exceptions, ledger, logs] = await Promise.all([
      ctx.db.query("employers").collect(),
      ctx.db.query("contributionBatches").collect(),
      ctx.db.query("exceptions").withIndex("by_status", (q) => q.eq("status", "open")).collect(),
      ctx.db.query("ledgerEntries").collect(),
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

/** Fee configuration (Fee Engine). */
export const getFeeConfig = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("systemConfig")
      .withIndex("by_key", (q) => q.eq("key", "per_employee_fee_kobo"))
      .first();
    return row?.value ?? 900; // default ₦9
  },
});

/** Audit trail for a batch — employer-scoped like getBatchDetail. */
export const getBatchAudit = query({
  args: { batchId: v.id("contributionBatches") },
  handler: async (ctx, { batchId }) => {
    const employer = await getCurrentEmployer(ctx);
    const batch = await ctx.db.get(batchId);
    if (employer && batch && batch.employerId !== employer._id) {
      throw new Error("Not authorized to view this batch");
    }
    return (
      await ctx.db
        .query("auditLogs")
        .withIndex("by_batch", (q) => q.eq("batchId", batchId))
        .collect()
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
        .collect()
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
        .collect()
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
        .collect()
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
        .collect()
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
      .collect();
    return employees
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
      .map((e) => ({
        _id: e._id,
        employeeCode: e.employeeCode,
        fullName: e.fullName,
        pensionPin: e.pensionPin,
        active: e.active,
        pfaName: pfaById.get(e.pfaId)?.name ?? "Unknown PFA",
        pfaCode: pfaById.get(e.pfaId)?.code ?? "?",
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
    if (!user) throw new Error("Not authenticated");
    const active = await ctx.db
      .query("employers")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .first();
    if (!active) throw new Error("No employer seeded yet");
    if (!active.ownerUserId) {
      await ctx.db.patch(active._id, { ownerUserId: user._id });
    }
    if (!user.employerId) {
      await ctx.db.patch(user._id, { employerId: active._id });
    }
    return { employerId: active._id as string, name: active.name };
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
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    if (!args.name.trim()) throw new Error("Company name is required");
    if (!args.rcNumber.trim()) throw new Error("RC number is required");
    if (!args.tin.trim()) throw new Error("TIN is required");
    if (!args.contactEmail.includes("@")) throw new Error("A valid contact email is required");

    const dupRc = await ctx.db
      .query("employers")
      .withIndex("by_rc", (q) => q.eq("rcNumber", args.rcNumber.trim()))
      .first();
    if (dupRc) throw new Error("An employer with this RC number already exists");

    const now = Date.now();
    const employerId = await ctx.db.insert("employers", {
      name: args.name.trim(),
      rcNumber: args.rcNumber.trim(),
      tin: args.tin.trim(),
      registeredAddress: args.registeredAddress.trim() || "—",
      contactEmail: args.contactEmail.trim(),
      contactPhone: args.contactPhone.trim() || "—",
      representativeName: args.representativeName.trim() || (user.name ?? "Admin"),
      status: "active",
      kycStatus: "verified",
      ownerUserId: user._id,
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
      details: `${args.name.trim()} (${args.rcNumber.trim()}) onboarded via self-service`,
      createdAt: now,
    });

    return { employerId };
  },
});

export const seedDemoData = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("employers").first();
    if (existing) return { seeded: false, reason: "already_seeded" };

    const now = Date.now();
    const user = await getCurrentUser(ctx);
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

    // Fee config: ₦9 per employee credit
    await ctx.db.insert("systemConfig", {
      key: "per_employee_fee_kobo",
      value: 900,
      updatedAt: now,
      updatedBy: "system-default",
    });

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
      throw new Error("Only platform admins can change pricing");
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
    await ctx.db.insert("auditLogs", {
      actor: user?.email ?? "admin",
      action: "update_fee_config",
      entityType: "systemConfig",
      details: `per-employee fee set to ${perEmployeeFeeKobo} kobo (previous: ${row?.value ?? "unset"})`,
      createdAt: now,
    });
    return { ok: true };
  },
});

export const resolveException = mutation({
  args: {
    exceptionId: v.id("exceptions"),
    notes: v.string(),
  },
  handler: async (ctx, { exceptionId, notes }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const exc = await ctx.db.get(exceptionId);
    if (!exc) throw new Error("Exception not found");
    // Employer users may only resolve their own exceptions; admins may resolve any.
    if (user.role !== "admin" && exc.employerId) {
      const mine = await getEmployerForUser(ctx, user);
      if (!mine || mine._id !== exc.employerId) {
        throw new Error("Not authorized to resolve this exception");
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

export const addEmployee = mutation({
  args: {
    fullName: v.string(),
    employeeCode: v.string(),
    pensionPin: v.string(),
    pfaId: v.id("pfas"),
  },
  handler: async (ctx, { fullName, employeeCode, pensionPin, pfaId }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const employer = await getEmployerForUser(ctx, user);
    if (!employer) throw new Error("No employer profile — seed or onboard first");

    const cleanPin = pensionPin.trim().toUpperCase().replace(/\s/g, "");
    if (!/^[A-Z0-9]{6,20}$/.test(cleanPin.replace(/-/g, ""))) {
      throw new Error("Invalid pension PIN format (6–20 letters/digits)");
    }
    if (!fullName.trim()) throw new Error("Employee name is required");
    if (!employeeCode.trim()) throw new Error("Employee ID is required");

    const pfa = await ctx.db.get(pfaId);
    if (!pfa) throw new Error("Unknown PFA");
    if (!isSelectable(pfa)) throw new Error(`${pfa.name} is inactive and cannot be selected for new pension records`);

    const dup = await ctx.db
      .query("employees")
      .withIndex("by_employer_pin", (q) =>
        q.eq("employerId", employer._id).eq("pensionPin", cleanPin),
      )
      .first();
    if (dup) throw new Error(`Pension PIN ${cleanPin} already exists for this employer`);

    const now = Date.now();
    const employeeId = await ctx.db.insert("employees", {
      employerId: employer._id,
      employeeCode: employeeCode.trim(),
      fullName: fullName.trim(),
      pensionPin: cleanPin,
      pfaId,
      active: true,
      createdAt: now,
    });
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
  },
  handler: async (ctx, { employeeId, fullName, employeeCode, pensionPin, pfaId }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const employer = await getEmployerForUser(ctx, user);
    if (!employer) throw new Error("No employer profile");

    const employee = await ctx.db.get(employeeId);
    if (!employee || employee.employerId !== employer._id) {
      throw new Error("Not authorized to modify this employee");
    }

    const cleanPin = pensionPin.trim().toUpperCase().replace(/\s/g, "");
    if (!/^[A-Z0-9]{6,20}$/.test(cleanPin.replace(/-/g, ""))) {
      throw new Error("Invalid pension PIN format (6–20 letters/digits)");
    }
    if (!fullName.trim()) throw new Error("Employee name is required");
    if (!employeeCode.trim()) throw new Error("Employee ID is required");

    const pfa = await ctx.db.get(pfaId);
    if (!pfa) throw new Error("Unknown PFA");
    // Inactive PFAs cannot be chosen for new/changed assignments; keeping an
    // employee on their existing (possibly deactivated) PFA remains allowed so
    // historical records keep resolving.
    if (pfaId !== employee.pfaId && !isSelectable(pfa)) {
      throw new Error(`${pfa.name} is inactive and cannot be selected for new pension records`);
    }

    // Duplicate-PIN check excludes the employee being edited.
    if (cleanPin !== employee.pensionPin) {
      const dup = await ctx.db
        .query("employees")
        .withIndex("by_employer_pin", (q) =>
          q.eq("employerId", employer._id).eq("pensionPin", cleanPin),
        )
        .first();
      if (dup) throw new Error(`Pension PIN ${cleanPin} already exists for this employer`);
    }

    await ctx.db.patch(employeeId, {
      fullName: fullName.trim(),
      employeeCode: employeeCode.trim(),
      pensionPin: cleanPin,
      pfaId,
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
    if (!user) throw new Error("Not authenticated");
    const employer = await getEmployerForUser(ctx, user);
    if (!employer) throw new Error("No employer profile");
    const employee = await ctx.db.get(employeeId);
    if (!employee || employee.employerId !== employer._id) {
      throw new Error("Not authorized to modify this employee");
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
export const internalAudit = mutation({
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
