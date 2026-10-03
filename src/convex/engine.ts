import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getCurrentUser } from "./users";
import { audit, getEmployerForUser } from "./employers";
import type { Doc } from "./_generated/dataModel";
import {
  logIntegration,
  pencomValidatePensionPinSandbox,
  settlementRailSandboxSubmit,
  pfaAcknowledgeSandbox,
} from "./adapters";
import { quoteForPostings } from "./pricing";
import { markChargeFailed, markChargePaid, syncBillingCharge } from "./billing";

// ============================================================================
// FEE ENGINE — pricing is centralised in the pricing service (pricing.ts) and
// the shared engine (src/lib/pricing.ts). Rates are administrator-configured
// tiers; nothing about pricing is hard-coded in this flow.
// ============================================================================

/** Read a numeric system flag (e.g. rail_mode) — configuration over code. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getSystemValue(ctx: any, key: string, fallback: number): Promise<number> {
  const row = await ctx.db
    .query("systemConfig")
    .withIndex("by_key", (q: any) => q.eq("key", key))
    .first();
  return row?.value ?? fallback;
}

/** Record an employer-facing webhook event (spec §28). */
async function webhookEvent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  args: {
    employerId?: Id<"employers">;
    batchId?: Id<"contributionBatches">;
    eventType: string;
    payload: string;
  },
) {
  await ctx.db.insert("webhookEvents", {
    employerId: args.employerId,
    batchId: args.batchId,
    eventType: args.eventType,
    payload: args.payload,
    status: "delivered",
    createdAt: Date.now(),
  });
}

function randRef(prefix: string, len = 6): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${s}`;
}

async function getEmployerForEngine(
  ctx: Parameters<typeof getEmployerForUser>[0],
  user: { _id: Id<"users">; employerId?: Id<"employers"> },
) {
  return await getEmployerForUser(ctx, user);
}

// ============================================================================
// QUERIES
// ============================================================================

/** Draft summary for the Review step (fee preview before payment). */
export const getDraftSummary = query({
  args: { year: v.number(), month: v.number() },
  handler: async (ctx, { year, month }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const employer = await getEmployerForEngine(ctx, user);
    if (!employer) return null;

    const batches = await ctx.db
      .query("contributionBatches")
      .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
      .collect();
    const batch = batches.find(
      (b) => b.contributionYear === year && b.contributionMonth === month && b.status !== "failed",
    );
    if (!batch) return null;

    const records = await ctx.db
      .query("contributionRecords")
      .withIndex("by_batch", (q) => q.eq("batchId", batch._id))
      .collect();

    const valid = records.filter((r) => r.validationStatus === "valid");
    const employeeSum = valid.reduce((s, r) => s + r.employeeContribution, 0);
    const employerSum = valid.reduce((s, r) => s + r.employerContribution, 0);
    const pension = employeeSum + employerSum;
    const quote = await quoteForPostings(ctx, valid.length);
    const feePerEmployee = quote.feePerPostingKobo;
    const fee = quote.processingFeeKobo;

    return {
      batch,
      validCount: valid.length,
      invalidCount: records.length - valid.length,
      employeeSum,
      employerSum,
      pension,
      feePerEmployee,
      fee,
      tier: {
        code: quote.tier.code,
        label: quote.tier.label,
        minEmployees: quote.tier.minEmployees,
        maxEmployees: quote.tier.maxEmployees,
      },
      totalDebit: pension + fee,
      records: records.sort((a, b) => a.fullName.localeCompare(b.fullName)),
    };
  },
});

/** Context for the live-rail verification action (no secret material). */
export const getLivePaymentContext = query({
  args: { batchId: v.id("contributionBatches") },
  handler: async (ctx, { batchId }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const employer = await getEmployerForEngine(ctx, user);
    if (!employer) return null;
    const batch = await ctx.db.get(batchId);
    if (!batch || batch.employerId !== employer._id) return null;
    const payment = await ctx.db
      .query("payments")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .first();
    if (!payment || payment.status === "successful" || payment.status === "failed") return null;
    return {
      paymentRef: payment.paymentRef,
      expectedKobo: payment.amount,
      payerEmail: employer.contactEmail,
    };
  },
});

// ============================================================================
// STEP 1 — Prepare batch: upload/API intake with validation + idempotency
// ============================================================================

/** Shape of one schedule row — shared by browser intake and payroll API intake. */
const scheduleRow = {
  fullName: v.string(),
  employeeCode: v.string(),
  pensionPin: v.string(),
  pfaCode: v.string(),
  employeeContribution: v.number(), // naira
  employerContribution: v.number(), // naira
};
type ScheduleRow = {
  fullName: string;
  employeeCode: string;
  pensionPin: string;
  pfaCode: string;
  employeeContribution: number;
  employerContribution: number;
};

export const prepareBatch = mutation({
  args: {
    year: v.number(),
    month: v.number(),
    records: v.array(v.object(scheduleRow)),
  },
  handler: async (ctx, { year, month, records }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const employer = await getEmployerForEngine(ctx, user);
    if (!employer) throw new Error("No employer profile. Complete onboarding first.");
    return createBatchCore(ctx, {
      employer,
      actor: user.email ?? "unknown",
      createdBy: user._id,
      year,
      month,
      records,
    });
  },
});

// ============================================================================
// PAYROLL/HR API INTAKE (spec §4) — employer payroll systems push the monthly
// schedule server-to-server using the employer's API key. Same idempotency,
// validation and audit guarantees as the browser flow — one core, two doors.
// ============================================================================

/** Internal: API-key-authenticated schedule intake, called by /api/v1/schedules. */
export const intakeApiSchedule = internalMutation({
  args: {
    apiKey: v.string(),
    year: v.number(),
    month: v.number(),
    records: v.array(v.object(scheduleRow)),
  },
  handler: async (ctx, { apiKey, year, month, records }) => {
    const employer = await ctx.db
      .query("employers")
      .filter((q) => q.eq(q.field("apiKey"), apiKey))
      .first();
    if (!employer) {
      return { ok: false as const, status: 401, error: "Invalid API key" };
    }
    if (employer.status === "suspended") {
      return { ok: false as const, status: 403, error: "Employer account is suspended" };
    }
    try {
      const res = await createBatchCore(ctx, {
        employer,
        actor: `payroll-api:${employer.rcNumber}`,
        year,
        month,
        records,
      });
      return {
        ok: true as const,
        batchRef: res.batchRef,
        duplicate: res.duplicate,
        validCount: res.validCount ?? null,
        invalidCount: res.invalidCount ?? null,
      };
    } catch (e) {
      return {
        ok: false as const,
        status: 400,
        error: e instanceof Error ? e.message : "Schedule intake failed",
      };
    }
  },
});

/** Shared batch-intake core — idempotency, validation, persistence, audit.
 *  Used by prepareBatch (browser) and intakeApiSchedule (payroll API). */
async function createBatchCore(
  ctx: Parameters<typeof audit>[0],
  opts: {
    employer: Doc<"employers">;
    actor: string;
    createdBy?: Id<"users">;
    year: number;
    month: number;
    records: ScheduleRow[];
  },
) {
  const { year, month, records } = opts;
  const employer = opts.employer;
  if (month < 1 || month > 12) throw new Error("Invalid contribution month");
  if (records.length === 0) throw new Error("Cannot submit an empty schedule");

    // ---- IDEMPOTENCY: batch fingerprint (spec §26) ----
    const canonical = [
      employer.rcNumber,
      String(year),
      String(month),
      ...records
        .map((r) =>
          [r.pensionPin.toUpperCase().replace(/\s/g, ""), r.pfaCode, String(r.employeeContribution), String(r.employerContribution)].join("|"),
        )
        .sort(),
    ].join(";");
    // FNV-1a deterministic hash
    let h1 = 0x811c9dc5;
    for (let i = 0; i < canonical.length; i++) {
      h1 ^= canonical.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193) >>> 0;
    }
    const fingerprint = `fp_${h1.toString(16)}`;

    const existing = await ctx.db
      .query("contributionBatches")
      .withIndex("by_fingerprint", (q) => q.eq("fingerprint", fingerprint))
      .first();
    if (existing && existing.status !== "failed") {
      return { duplicate: true as const, batchId: existing._id, batchRef: existing.batchRef };
    }

    // Duplicate-contribution guard: a live batch already exists for this period
    const allBatches = await ctx.db
      .query("contributionBatches")
      .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
      .collect();
    const periodBatch = allBatches.find(
      (b) => b.contributionYear === year && b.contributionMonth === month && b.status !== "failed",
    );
    if (periodBatch) {
      return { duplicate: true as const, batchId: periodBatch._id, batchRef: periodBatch.batchRef };
    }

    // ---- VALIDATION (spec §6, §8) — validate every record, reject nothing silently ----
    const pfas = await ctx.db.query("pfas").collect();
    if (pfas.length === 0) throw new Error("No PFAs configured on the platform");
    // Selectable PFAs only — inactive PFAs cannot enter NEW contribution
    // batches (their records stay visible historically via pfaId).
    const pfaByCode = new Map(
      pfas
        .filter((p) => p.active !== false && p.status !== "INACTIVE")
        .map((p) => [p.code, p]),
    );
    // Attribution map (incl. inactive rows) so invalid rows still reference a
    // real master record instead of a free-text value.
    const pfaAllByCode = new Map(pfas.map((p) => [p.code, p]));
    const pinSeen = new Map<string, number>();
    for (const r of records) {
      const k = r.pensionPin.toUpperCase().replace(/\s/g, "");
      pinSeen.set(k, (pinSeen.get(k) ?? 0) + 1);
    }

    const batchRef = `BATCH-${year}-${String(month).padStart(2, "0")}-${randRef("", 5)}`;

    const batchId = await ctx.db.insert("contributionBatches", {
      employerId: employer._id,
      batchRef,
      fingerprint,
      contributionMonth: month,
      contributionYear: year,
      employeeCount: records.length,
      totalEmployeeContribution: 0,
      totalEmployerContribution: 0,
      totalPensionAmount: 0,
      platformFee: 0,
      totalDebit: 0,
      status: "awaiting_payment",
      paymentStatus: "pending",
      allocationStatus: "pending",
      settlementStatus: "pending",
      pfaStatus: "awaiting_ack",
      reconciliationStatus: "pending",
      createdAt: Date.now(),
      createdBy: opts.createdBy,
    });

    let validCount = 0;
    for (const r of records) {
      const pin = r.pensionPin.toUpperCase().replace(/\s/g, "");
      const pfa = pfaByCode.get(r.pfaCode);
      const dupPin = (pinSeen.get(pin) ?? 0) > 1;
      const pinCheck = pencomValidatePensionPinSandbox(pin, r.pfaCode); // PENCOM sandbox adapter
      const amountsOk =
        r.employeeContribution >= 0 && r.employerContribution >= 0 && r.employeeContribution + r.employerContribution > 0;

      let validationStatus = "valid";
      let validationError: string | undefined;
      if (!pin) {
        validationStatus = "invalid";
        validationError = "missing_pin";
      } else if (!pinCheck.valid) {
        validationStatus = "invalid";
        validationError = pinCheck.reason;
      } else if (!pfa) {
        validationStatus = "invalid";
        validationError = "unknown_pfa";
      } else if (dupPin) {
        validationStatus = "invalid";
        validationError = "duplicate_pin_in_schedule";
      } else if (!amountsOk) {
        validationStatus = "invalid";
        validationError = "incorrect_amount";
      }
      if (validationStatus === "valid") validCount++;

      // Link the record to the employee roster entry where the PIN matches.
      const rosterEntry = await ctx.db
        .query("employees")
        .withIndex("by_employer_pin", (q) => q.eq("employerId", employer._id).eq("pensionPin", pin))
        .first();

      await ctx.db.insert("contributionRecords", {
        batchId,
        employerId: employer._id,
        employeeId: rosterEntry?._id,
        fullName: r.fullName,
        employeeCode: r.employeeCode,
        pensionPin: pin,
        // Reference a real master record: the resolved PFA, else the actual row
        // for that code (even if inactive), else first row as last resort.
        pfaId: pfa?._id ?? pfaAllByCode.get(r.pfaCode)?._id ?? pfas[0]._id,
        employeeContribution: Math.round(r.employeeContribution * 100),
        employerContribution: Math.round(r.employerContribution * 100),
        totalAmount: Math.round((r.employeeContribution + r.employerContribution) * 100),
        contributionMonth: month,
        contributionYear: year,
        validationStatus,
        validationError,
        allocationStatus: "pending",
        settlementStatus: "pending",
        pfaStatus: "awaiting_ack",
        recordRef: randRef("REC", 6),
        createdAt: Date.now(),
      });
    }

    await logIntegration(ctx, {
      adapter: "pencom_sandbox",
      operation: "validate_schedule",
      requestSummary: `${records.length} records for ${year}-${month}`,
      responseSummary: `${validCount} valid, ${records.length - validCount} invalid`,
      success: validCount > 0,
      batchId,
    });
    await audit(ctx, {
      actor: opts.actor,
      action: "prepare_batch",
      entityType: "batch",
      entityId: batchRef,
      employerId: employer._id,
      batchId,
      details: `${records.length} records submitted, ${validCount} valid`,
    });
    await webhookEvent(ctx, {
      employerId: employer._id,
      batchId,
      eventType: "batch.received",
      payload: JSON.stringify({ batchRef, employees: records.length, valid: validCount }),
    });

    return { duplicate: false as const, batchId, batchRef, validCount, invalidCount: records.length - validCount };
}

// ============================================================================
// STEP 2 — Pay: ONE consolidated payment (pension + ₦9/employee fee)
// Sandbox rail: settles instantly and runs the pipeline.
// Live rail (Paystack): creates an initiated payment and returns checkout
// details; the ledger is only written after Paystack VERIFIES the payment
// (spec §15 — never overstate).
// ============================================================================

export const payBatch = mutation({
  args: { batchId: v.id("contributionBatches") },
  handler: async (ctx, { batchId }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const employer = await getEmployerForEngine(ctx, user);
    if (!employer) throw new Error("No employer profile");

    const batch = await ctx.db.get(batchId);
    if (!batch || batch.employerId !== employer._id) throw new Error("Batch not found");
    if (batch.status !== "awaiting_payment") throw new Error(`Batch is not payable (status: ${batch.status})`);

    const records = await ctx.db
      .query("contributionRecords")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .collect();
    const valid = records.filter((r) => r.validationStatus === "valid");
    if (valid.length === 0) throw new Error("No valid records to pay");

    const employeeSum = valid.reduce((s, r) => s + r.employeeContribution, 0);
    const employerSum = valid.reduce((s, r) => s + r.employerContribution, 0);
    const pension = employeeSum + employerSum;
    // Billing charge — the FIRST quote for this batch wins (idempotent
    // snapshot): retries and later pricing changes never re-price it.
    const charge = await syncBillingCharge(ctx, {
      batch,
      postingCount: valid.length,
      contributionKobo: pension,
      actor: user.email ?? "unknown",
    });
    const feePerEmployee = charge.feePerPostingKobo;
    const fee = charge.processingFeeKobo;
    const totalDebit = pension + fee;

    const paymentRef = randRef("PMT", 8);
    const idempotencyKey = batch.fingerprint;

    // IDEMPOTENT payment creation
    const existingPayment = await ctx.db
      .query("payments")
      .withIndex("by_idem", (q) => q.eq("idempotencyKey", idempotencyKey))
      .first();
    if (existingPayment && existingPayment.status === "successful") {
      return { paymentRef: existingPayment.paymentRef, alreadyPaid: true as const };
    }

    const railMode = (await getSystemValue(ctx, "rail_mode", 0)) === 1 ? "live" : "sandbox";

    if (railMode === "live") {
      // ---- LIVE RAIL: initiate checkout; confirmation happens in
      // confirmLivePayment → finalizeLivePayment after provider verification ----
      if (existingPayment && (existingPayment.status === "initiated" || existingPayment.status === "processing")) {
        return {
          requiresCheckout: true as const,
          paymentRef: existingPayment.paymentRef,
          amountKobo: existingPayment.amount,
          payerEmail: employer.contactEmail,
          batchId,
        };
      }
      const paymentId = await ctx.db.insert("payments", {
        batchId,
        employerId: employer._id,
        paymentRef,
        idempotencyKey,
        amount: totalDebit,
        pensionAmount: pension,
        platformFee: fee,
        rail: "paystack",
        status: "initiated",
        initiatedAt: Date.now(),
      });
      await ctx.db.patch(batchId, {
        paymentStatus: "initiated",
        totalEmployeeContribution: employeeSum,
        totalEmployerContribution: employerSum,
        totalPensionAmount: pension,
        platformFee: fee,
        totalDebit,
      });
      await audit(ctx, {
        actor: user.email ?? "unknown",
        action: "payment_initiated",
        entityType: "payment",
        entityId: paymentRef,
        employerId: employer._id,
        batchId,
        details: `Live rail checkout initiated for ₦${(totalDebit / 100).toLocaleString()}`,
      });
      await webhookEvent(ctx, {
        employerId: employer._id,
        batchId,
        eventType: "payment.initiated",
        payload: JSON.stringify({ paymentRef, amountKobo: totalDebit, rail: "paystack" }),
      });
      void paymentId;
      return {
        requiresCheckout: true as const,
        paymentRef,
        amountKobo: totalDebit,
        payerEmail: employer.contactEmail,
        batchId,
      };
    }

    // ---- SANDBOX PAYMENT RAIL (replace with approved live rail; spec §38) ----
    const railResult = settlementRailSandboxSubmit(paymentRef, totalDebit);
    await logIntegration(ctx, {
      adapter: "settlement_sandbox",
      operation: "collect_employer_payment",
      requestSummary: `${paymentRef} ₦${(totalDebit / 100).toLocaleString()} from ${employer.name}`,
      responseSummary: JSON.stringify(railResult),
      success: railResult.accepted,
      batchId,
    });
    if (!railResult.accepted) {
      await markChargeFailed(ctx, batchId);
      throw new Error("Payment rail declined the collection");
    }

    const paymentId = await ctx.db.insert("payments", {
      batchId,
      employerId: employer._id,
      paymentRef,
      idempotencyKey,
      amount: totalDebit,
      pensionAmount: pension,
      platformFee: fee,
      rail: "sandbox_transfer",
      status: "successful",
      providerRef: railResult.providerRef ?? undefined,
      initiatedAt: Date.now(),
      confirmedAt: Date.now(),
    });

    await recordSuccessfulPayment(ctx, {
      batchId,
      employerId: employer._id,
      employerName: employer.name,
      valid,
      feePerEmployee,
      paymentRef,
      rail: "sandbox_transfer",
      providerRef: railResult.providerRef ?? undefined,
      actor: user.email ?? "unknown",
    });

    return { paymentRef, alreadyPaid: false as const };
  },
});

/** Shared: write the double-entry ledger + flip the batch to processing. */
async function recordSuccessfulPayment(
  ctx: Parameters<typeof audit>[0],
  opts: {
    batchId: Id<"contributionBatches">;
    employerId: Id<"employers">;
    employerName: string;
    valid: { pfaId: Id<"pfas">; totalAmount: number }[];
    feePerEmployee: number;
    paymentRef: string;
    rail: string;
    providerRef?: string;
    actor: string;
  },
) {
  const allPfas = await ctx.db.query("pfas").collect();
  const pfaCodeById = new Map(allPfas.map((p) => [String(p._id), p.code]));

  const employeeSum = opts.valid.reduce((s, r) => s + (r as any).employeeContribution, 0);
  const employerSum = opts.valid.reduce((s, r) => s + (r as any).employerContribution, 0);
  const pension = employeeSum + employerSum;
  const fee = opts.valid.length * opts.feePerEmployee;
  const totalDebit = pension + fee;
  const now = Date.now();

  const payment = await ctx.db
    .query("payments")
    .withIndex("by_batch", (q) => q.eq("batchId", opts.batchId))
    .first();

  // ---- DOUBLE-ENTRY LEDGER (spec §25) — pension funds ≠ platform revenue ----
  const entryRef = randRef("LED", 6);
  const pfaGroups = dedupeByPfa(opts.valid, pfaCodeById);
  const rows = [
    { account: "employer_debit", debit: totalDebit, credit: 0, pfaId: undefined as Id<"pfas"> | undefined, narration: `Consolidated pension payment ${opts.paymentRef}` },
    ...pfaGroups.map((g) => ({
      account: "pfa_payable",
      debit: 0,
      credit: g.amount,
      pfaId: g.pfaId as Id<"pfas"> | undefined,
      narration: `Pension allocation → PFA ${g.pfaCode} (${g.count} employees)`,
    })),
    { account: "platform_revenue", debit: 0, credit: fee, pfaId: undefined, narration: `Penroute processing fee ${opts.valid.length} × ₦${(opts.feePerEmployee / 100).toFixed(2)} (technology/service charge — not a pension contribution)` },
    { account: "clearing", debit: 0, credit: pension, pfaId: undefined, narration: `Pension clearing ${opts.paymentRef}` },
    { account: "clearing", debit: pension, credit: 0, pfaId: undefined, narration: `Pension clearing offset ${opts.paymentRef}` },
  ];
  for (const row of rows) {
    await ctx.db.insert("ledgerEntries", {
      entryRef,
      batchId: opts.batchId,
      paymentId: payment?._id,
      employerId: opts.employerId,
      pfaId: row.pfaId,
      account: row.account,
      debit: row.debit,
      credit: row.credit,
      currency: "NGN",
      narration: row.narration,
      reconciliationStatus: "pending",
      entryDate: now,
    });
  }

  if (payment) {
    await ctx.db.patch(payment._id, {
      status: "successful",
      confirmedAt: now,
      providerRef: opts.providerRef ?? payment.providerRef,
    });
  }

  await ctx.db.patch(opts.batchId, {
    paymentStatus: "successful",
    status: "processing",
    paymentRef: opts.paymentRef,
    paymentDate: now,
    totalEmployeeContribution: employeeSum,
    totalEmployerContribution: employerSum,
    totalPensionAmount: pension,
    platformFee: fee,
    totalDebit,
  });

  await audit(ctx, {
    actor: opts.actor,
    action: "payment_successful",
    entityType: "payment",
    entityId: opts.paymentRef,
    employerId: opts.employerId,
    batchId: opts.batchId,
    details: `₦${(totalDebit / 100).toLocaleString()} via ${opts.rail} (pension ₦${(pension / 100).toLocaleString()} + fee ₦${(fee / 100).toLocaleString()})`,
  });
  await webhookEvent(ctx, {
    employerId: opts.employerId,
    batchId: opts.batchId,
    eventType: "payment.successful",
    payload: JSON.stringify({ paymentRef: opts.paymentRef, amountKobo: totalDebit, rail: opts.rail }),
  });

  // Recognise the billing charge as revenue only now that payment is confirmed.
  await markChargePaid(ctx, { batchId: opts.batchId, paymentRef: opts.paymentRef });

  return { pension, fee, totalDebit };
}

function dedupeByPfa(valid: { pfaId: Id<"pfas">; totalAmount: number }[], pfaCodeById: Map<string, string>) {
  const map = new Map<string, { pfaId: Id<"pfas">; pfaCode: string; amount: number; count: number }>();
  for (const r of valid) {
    const key = String(r.pfaId);
    const cur = map.get(key);
    if (cur) {
      cur.amount += r.totalAmount;
      cur.count += 1;
    } else {
      map.set(key, { pfaId: r.pfaId, pfaCode: pfaCodeById.get(key) ?? "?", amount: r.totalAmount, count: 1 });
    }
  }
  return [...map.values()];
}

/** Live rail: mark a verified-failed payment (declined/abandoned/underpaid). */
export const markLivePaymentFailed = mutation({
  args: { batchId: v.id("contributionBatches"), reason: v.string() },
  handler: async (ctx, { batchId, reason }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const employer = await getEmployerForEngine(ctx, user);
    if (!employer) throw new Error("No employer profile");
    const batch = await ctx.db.get(batchId);
    if (!batch || batch.employerId !== employer._id) throw new Error("Batch not found");

    const payment = await ctx.db
      .query("payments")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .first();
    if (!payment) throw new Error("No payment found for this batch");
    if (payment.status === "successful") throw new Error("Payment already confirmed");

    await ctx.db.patch(payment._id, { status: "failed", failureReason: reason });
    await ctx.db.patch(batchId, { paymentStatus: "failed" });
    await markChargeFailed(ctx, batchId);
    await ctx.db.insert("exceptions", {
      batchId,
      employerId: employer._id,
      exceptionRef: randRef("EXC", 6),
      type: "payment_mismatch",
      description: `Live payment ${payment.paymentRef} not successful: ${reason}`,
      amount: payment.amount,
      status: "open",
      responsibleParty: "employer",
      createdAt: Date.now(),
    });
    await audit(ctx, {
      actor: user.email ?? "unknown",
      action: "payment_failed",
      entityType: "payment",
      entityId: payment.paymentRef,
      employerId: employer._id,
      batchId,
      details: reason,
    });
    await webhookEvent(ctx, {
      employerId: employer._id,
      batchId,
      eventType: "payment.failed",
      payload: JSON.stringify({ paymentRef: payment.paymentRef, reason }),
    });
    return { ok: true };
  },
});

// ============================================================================
// SYSTEM PATHS — invoked by the Paystack webhook (paystackWebhook.ts).
// Internal functions: not callable from the browser, only from server code.
// ============================================================================

/** Look up a payment by its provider reference (webhook). */
export const getPaymentByRef = internalQuery({
  args: { paymentRef: v.string() },
  handler: async (ctx, { paymentRef }) => {
    return await ctx.db
      .query("payments")
      .withIndex("by_ref", (q) => q.eq("paymentRef", paymentRef))
      .first();
  },
});

/** Webhook-confirmed success: finalize with the same guarantees as the
 *  interactive path (idempotent, ledger-first, full audit). */
export const finalizeLivePaymentSystem = internalMutation({
  args: { paymentId: v.id("payments"), providerFeesKobo: v.optional(v.number()) },
  handler: async (ctx, { paymentId, providerFeesKobo }) => {
    const payment = await ctx.db.get(paymentId);
    if (!payment) throw new Error("Payment not found");
    if (payment.status === "successful") {
      return { ok: true as const, alreadyProcessed: true };
    }
    const batch = await ctx.db.get(payment.batchId);
    if (!batch) throw new Error("Batch not found");
    const employer = await ctx.db.get(payment.employerId);
    const records = await ctx.db
      .query("contributionRecords")
      .withIndex("by_batch", (q) => q.eq("batchId", payment.batchId))
      .collect();
    const valid = records.filter((r) => r.validationStatus === "valid");
    const pensionKobo = valid.reduce((s, r) => s + r.totalAmount, 0);
    const charge = await syncBillingCharge(ctx, {
      batch,
      postingCount: valid.length,
      contributionKobo: pensionKobo,
      actor: "paystack-webhook",
    });
    const feePerEmployee = charge.feePerPostingKobo;

    await recordSuccessfulPayment(ctx, {
      batchId: payment.batchId,
      employerId: payment.employerId,
      employerName: employer?.name ?? "Employer",
      valid,
      feePerEmployee,
      paymentRef: payment.paymentRef,
      rail: payment.rail,
      providerRef: payment.providerRef,
      actor: "paystack-webhook",
    });
    void providerFeesKobo;
    return { ok: true as const, status: "processing" };
  },
});

/** Webhook-confirmed failure/mismatch: mark failed + exception (system actor). */
export const markLivePaymentFailedSystem = internalMutation({
  args: { paymentId: v.id("payments"), reason: v.string() },
  handler: async (ctx, { paymentId, reason }) => {
    const payment = await ctx.db.get(paymentId);
    if (!payment || payment.status === "successful") return { ok: true as const };

    await ctx.db.patch(paymentId, { status: "failed", failureReason: reason });
    await ctx.db.patch(payment.batchId, { paymentStatus: "failed" });
    await markChargeFailed(ctx, payment.batchId);
    await ctx.db.insert("exceptions", {
      batchId: payment.batchId,
      employerId: payment.employerId,
      exceptionRef: randRef("EXC", 6),
      type: "payment_mismatch",
      description: `Live payment ${payment.paymentRef} not successful: ${reason}`,
      amount: payment.amount,
      status: "open",
      responsibleParty: "employer",
      createdAt: Date.now(),
    });
    await audit(ctx, {
      actor: "paystack-webhook",
      action: "payment_failed",
      entityType: "payment",
      entityId: payment.paymentRef,
      employerId: payment.employerId,
      batchId: payment.batchId,
      details: reason,
    });
    await webhookEvent(ctx, {
      employerId: payment.employerId,
      batchId: payment.batchId,
      eventType: "payment.failed",
      payload: JSON.stringify({ paymentRef: payment.paymentRef, reason }),
    });
    return { ok: true as const };
  },
});

/** Live rail: finalize a VERIFIED successful payment (called by the
 *  confirmLivePayment action after Paystack verification). */
export const finalizeLivePayment = mutation({
  args: { batchId: v.id("contributionBatches"), providerFeesKobo: v.optional(v.number()) },
  handler: async (ctx, { batchId, providerFeesKobo }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const employer = await getEmployerForEngine(ctx, user);
    if (!employer) throw new Error("No employer profile");
    const batch = await ctx.db.get(batchId);
    if (!batch || batch.employerId !== employer._id) throw new Error("Batch not found");

    const payment = await ctx.db
      .query("payments")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .first();
    if (!payment) throw new Error("No payment found for this batch");
    if (payment.status === "successful") {
      return { ok: true as const, status: "processing" };
    }

    const records = await ctx.db
      .query("contributionRecords")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .collect();
    const valid = records.filter((r) => r.validationStatus === "valid");
    const pensionKobo = valid.reduce((s, r) => s + r.totalAmount, 0);
    const charge = await syncBillingCharge(ctx, {
      batch,
      postingCount: valid.length,
      contributionKobo: pensionKobo,
      actor: user.email ?? "unknown",
    });
    const feePerEmployee = charge.feePerPostingKobo;

    await recordSuccessfulPayment(ctx, {
      batchId,
      employerId: employer._id,
      employerName: employer.name,
      valid,
      feePerEmployee,
      paymentRef: payment.paymentRef,
      rail: payment.rail,
      providerRef: payment.providerRef,
      actor: user.email ?? "unknown",
    });
    void providerFeesKobo;

    return { ok: true as const, status: "processing" };
  },
});

// ============================================================================
// STEP 3 — Pipeline: allocate → settle → PFA ack → reconcile → complete
// Idempotent: settlements and acknowledgements are only created if missing, so
// a retry after a mid-pipeline failure resumes without duplicating money
// movement (spec §40).
// ============================================================================

export const processPipeline = mutation({
  args: { batchId: v.id("contributionBatches") },
  handler: async (ctx, { batchId }) => {
    const batch = await ctx.db.get(batchId);
    if (!batch) throw new Error("Batch not found");
    if (batch.status !== "processing") throw new Error(`Batch not in processing state (${batch.status})`);

    const now = Date.now();

    // ---- ALLOCATION ENGINE: route each record to its PFA ----
    const records = await ctx.db
      .query("contributionRecords")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .collect();
    const valid = records.filter((r) => r.validationStatus === "valid");

    if (batch.allocationStatus !== "allocated") {
      await ctx.db.patch(batchId, { allocationStatus: "allocating" });
      for (const r of valid) {
        await ctx.db.patch(r._id, { allocationStatus: "allocated" });
      }
      await ctx.db.patch(batchId, { allocationStatus: "allocated" });
      await audit(ctx, {
        actor: "system",
        action: "allocation_completed",
        entityType: "batch",
        employerId: batch.employerId,
        batchId,
        details: `${valid.length} records allocated across ${new Set(valid.map((r) => String(r.pfaId))).size} PFAs`,
      });
      await webhookEvent(ctx, {
        employerId: batch.employerId,
        batchId,
        eventType: "allocation.completed",
        payload: JSON.stringify({ records: valid.length }),
      });
    }

    // ---- SETTLEMENT ENGINE: one instruction per PFA through the sandbox rail ----
    await ctx.db.patch(batchId, { settlementStatus: "processing" });
    const payment = await ctx.db
      .query("payments")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .first();
    if (!payment) throw new Error("Payment missing for batch");

    const existingSettlements = await ctx.db
      .query("settlements")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .collect();
    const settlementByPfa = new Map(existingSettlements.map((s) => [String(s.pfaId), s]));

    const pfaRows = await ctx.db.query("pfas").collect();
    const pfaMode = new Map(pfaRows.map((p) => [String(p._id), p.integrationMode]));
    const pfaGroups = new Map<string, { pfaId: Id<"pfas">; amount: number; count: number }>();
    for (const r of valid) {
      const key = String(r.pfaId);
      const g = pfaGroups.get(key);
      if (g) {
        g.amount += r.totalAmount;
        g.count += 1;
      } else {
        pfaGroups.set(key, { pfaId: r.pfaId, amount: r.totalAmount, count: 1 });
      }
    }

    for (const g of pfaGroups.values()) {
      const key = String(g.pfaId);
      if (settlementByPfa.has(key)) continue; // idempotent resume — never duplicate settlements

      const settlementRef = randRef("STL", 8);
      // LIVE PFA: queue the instruction — dispatchLiveSettlements delivers the
      // contribution file to the PFA's approved endpoint (server-side creds).
      if (pfaMode.get(key) === "live_api") {
        const liveId = await ctx.db.insert("settlements", {
          batchId,
          paymentId: payment._id,
          pfaId: g.pfaId,
          settlementRef,
          amount: g.amount,
          employeeCount: g.count,
          status: "pending",
          instructedAt: now,
        });
        settlementByPfa.set(key, { ...g, _id: liveId, settlementRef } as any);
        await logIntegration(ctx, {
          adapter: "pfa_live",
          operation: "settlement_queued",
          requestSummary: `${settlementRef} ₦${(g.amount / 100).toLocaleString()} → live PFA`,
          responseSummary: "queued for dispatch",
          success: true,
          batchId,
        });
        continue;
      }
      const railResult = settlementRailSandboxSubmit(settlementRef, g.amount);
      const settlementId = await ctx.db.insert("settlements", {
        batchId,
        paymentId: payment._id,
        pfaId: g.pfaId,
        settlementRef,
        amount: g.amount,
        employeeCount: g.count,
        status: railResult.accepted ? "settled" : "failed",
        instructedAt: now,
        confirmedAt: railResult.accepted ? now : undefined,
        failureReason: railResult.accepted ? undefined : railResult.reason,
      });
      settlementByPfa.set(key, { ...g, _id: settlementId, settlementRef } as any);
      await logIntegration(ctx, {
        adapter: "settlement_sandbox",
        operation: "settle_to_pfa",
        requestSummary: `${settlementRef} ₦${(g.amount / 100).toLocaleString()} → PFA`,
        responseSummary: JSON.stringify(railResult),
        success: railResult.accepted,
        batchId,
      });
      if (!railResult.accepted) {
        await ctx.db.insert("exceptions", {
          batchId,
          employerId: batch.employerId,
          pfaId: g.pfaId,
          exceptionRef: randRef("EXC", 6),
          type: "settlement_failed",
          description: `Settlement instruction ${settlementRef} for ₦${(g.amount / 100).toLocaleString()} was rejected by the settlement rail`,
          amount: g.amount,
          status: "open",
          responsibleParty: "platform",
          createdAt: Date.now(),
        });
      }
    }

    const finalSettlements = await ctx.db
      .query("settlements")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .collect();
    const settledSettlements = finalSettlements.filter((s) => s.status === "settled");
    // LIVE dispatch: hand every not-yet-confirmed instruction to the dispatch
    // action (pending = never sent / retry after failure; processing = PFA
    // acknowledged receipt but has not posted yet — re-poll, idempotent by
    // settlementRef). Scheduling from the mutation keeps the state machine
    // running even if the employer closes the browser (spec §40).
    const inFlight = finalSettlements.filter(
      (s) => s.status === "pending" || s.status === "processing",
    );
    if (inFlight.length > 0) {
      await ctx.scheduler.runAfter(0, api.pfaDispatch.dispatchLiveSettlements, { batchId });
      if (settledSettlements.length === 0) {
        await ctx.db.patch(batchId, { settlementStatus: "processing" });
      } else {
        await ctx.db.patch(batchId, { settlementStatus: "partially_settled" });
      }
      return {
        dispatched: true as const,
        pending: inFlight.filter((s) => s.status === "pending").length,
        awaitingPfa: inFlight.filter((s) => s.status === "processing").length,
      };
    }
    if (settledSettlements.length === finalSettlements.length && finalSettlements.length > 0) {
      await ctx.db.patch(batchId, { settlementStatus: "settled" });
      await webhookEvent(ctx, {
        employerId: batch.employerId,
        batchId,
        eventType: "settlement.completed",
        payload: JSON.stringify({ settlements: finalSettlements.length }),
      });
    } else if (settledSettlements.length > 0) {
      await ctx.db.patch(batchId, { settlementStatus: "partially_settled" });
    } else {
      await ctx.db.patch(batchId, { settlementStatus: "failed" });
    }

    // ---- PFA ADAPTER: acknowledgement + posting (sandbox) — idempotent ----
    const existingAcks = await ctx.db
      .query("pfaAcknowledgements")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .collect();
    const ackedSettlements = new Set(existingAcks.map((a) => String(a.settlementId)));

    for (const settlement of finalSettlements) {
      if (settlement.status !== "settled") continue;
      if (ackedSettlements.has(String(settlement._id))) continue; // idempotent resume
      // Live PFAs: the dispatch recorder already wrote the real acknowledgement
      // (received/accepted/posted) — never synthesize one here.
      if (pfaMode.get(String(settlement.pfaId)) === "live_api") continue;

      const ack = pfaAcknowledgeSandbox(settlement.settlementRef);
      await ctx.db.insert("pfaAcknowledgements", {
        settlementId: settlement._id,
        batchId,
        pfaId: settlement.pfaId,
        status: ack.status,
        message: ack.message,
        receivedAt: Date.now(),
      });
      await logIntegration(ctx, {
        adapter: "pfa_sandbox",
        operation: "pfa_acknowledgement",
        requestSummary: `contribution file for ${settlement.settlementRef}`,
        responseSummary: JSON.stringify(ack),
        success: true,
        batchId,
      });
    }

    // Per-record PFA status from the ACTUAL ack for that record's settlement —
    // a record is only "posted" when its own PFA acknowledged posting.
    const ackRows: { pfaId: Id<"pfas">; status: string }[] = existingAcks.map((a) => ({
      pfaId: a.pfaId,
      status: a.status,
    }));
    for (const s of finalSettlements) {
      if (s.status === "settled" && !ackedSettlements.has(String(s._id))) {
        ackRows.push({ pfaId: s.pfaId, status: "posted" });
      }
    }
    const ackByPfa = new Map(ackRows.map((a) => [String(a.pfaId), a.status]));
    for (const r of valid) {
      const settlement = settlementByPfa.get(String(r.pfaId)) as any;
      const ackStatus = settlement && ackByPfa.get(String(r.pfaId));
      await ctx.db.patch(r._id, {
        settlementStatus: settlement
          ? settlement.status === "settled"
            ? "settled"
            : "failed"
          : "pending",
        pfaStatus: settlement?.status === "settled" ? (ackStatus ?? "awaiting_ack") : "awaiting_ack",
      });
    }
    await ctx.db.patch(batchId, { pfaStatus: "posted" });

    // ---- RECONCILIATION ENGINE (spec §16): verify every figure ----
    const schedulePension = valid.reduce((s, r) => s + r.totalAmount, 0);
    const settledSum = settledSettlements.reduce((s, x) => s + x.amount, 0);
    const paymentSum = payment.pensionAmount;

    let reconciliationStatus = "reconciled";
    if (settledSum !== paymentSum || schedulePension !== paymentSum) {
      reconciliationStatus = "exception";
      const alreadyOpen = await ctx.db
        .query("exceptions")
        .withIndex("by_batch", (q) => q.eq("batchId", batchId))
        .filter((q) => q.eq(q.field("type"), "reconciliation_mismatch"))
        .first();
      if (!alreadyOpen) {
        const discrepancy = Math.abs(paymentSum - settledSum);
        await ctx.db.insert("exceptions", {
          batchId,
          employerId: batch.employerId,
          exceptionRef: randRef("EXC", 6),
          type: "reconciliation_mismatch",
          description: `Payment ₦${(paymentSum / 100).toLocaleString()} vs settled ₦${(settledSum / 100).toLocaleString()} vs schedule ₦${(schedulePension / 100).toLocaleString()} (discrepancy ₦${(discrepancy / 100).toLocaleString()})`,
          amount: discrepancy,
          status: "open",
          responsibleParty: "platform",
          createdAt: Date.now(),
        });
      }
    }

    const ledgerRows = await ctx.db
      .query("ledgerEntries")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .collect();
    for (const row of ledgerRows) {
      await ctx.db.patch(row._id, {
        reconciliationStatus: reconciliationStatus === "reconciled" ? "reconciled" : "exception",
      });
    }

    await ctx.db.patch(batchId, {
      reconciliationStatus,
      status: reconciliationStatus === "reconciled" ? "completed" : "processing",
      completedAt: reconciliationStatus === "reconciled" ? Date.now() : undefined,
    });

    await audit(ctx, {
      actor: "system",
      action: reconciliationStatus === "reconciled" ? "batch_completed" : "reconciliation_exception",
      entityType: "batch",
      employerId: batch.employerId,
      batchId,
      details:
        reconciliationStatus === "reconciled"
          ? `Reconciled: schedule = settlements = payment = ₦${(paymentSum / 100).toLocaleString()}`
          : "Mismatch detected — exception raised",
    });
    if (reconciliationStatus === "reconciled") {
      await webhookEvent(ctx, {
        employerId: batch.employerId,
        batchId,
        eventType: "reconciliation.completed",
        payload: JSON.stringify({ paymentSum, settledSum, schedulePension }),
      });
    }

    return { status: reconciliationStatus === "reconciled" ? "completed" : "exception", settledSum, paymentSum };
  },
});
