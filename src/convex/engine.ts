import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
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
import { quoteForEmployer } from "./pricing";
import { markChargeFailed, markChargeInvoiced, markChargePaid, syncBillingCharge } from "./billing";
import { readPaymentCharges } from "./paymentCharges";
import { processingChargeKobo, type PayMethod } from "../lib/paymentCharges";
import { hashApiKey, randRef } from "../lib/security";
import { sandboxModeEnabled } from "./environment";
import { notify } from "./notifications";

/** Largest single contribution amount accepted per field (₦1bn) — guards
 *  against typos/overflow; real monthly pension amounts are far below this. */
const MAX_CONTRIBUTION_NAIRA = 1_000_000_000;

/** The batch's current payment attempt: the newest non-failed payment, else
 *  the newest attempt. A batch can have several attempts after a failure, so
 *  `.first()` on the index would return a stale (failed) one. */
export async function getActivePayment(
  ctx: { db: QueryCtx["db"] },
  batchId: Id<"contributionBatches">,
): Promise<Doc<"payments"> | null> {
  const all = await ctx.db
    .query("payments")
    .withIndex("by_batch", (q) => q.eq("batchId", batchId))
    .take(100);
  if (all.length === 0) return null;
  const newestFirst = all.sort((a, b) => b.initiatedAt - a.initiatedAt || (b._creationTime - a._creationTime));
  return newestFirst.find((p) => p.status !== "failed") ?? newestFirst[0];
}

/** Rail mode: live (Paystack) or sandbox. Sandbox is only honoured on
 *  deployments that explicitly opt in (PENROUTE_SANDBOX_MODE=enabled). */
/** Payment route: "direct" (Penroute collects via its own Paystack account)
 *  or "partner" (a PenCom-approved provider collects and remits). */
export async function resolvePaymentRoute(ctx: { db: QueryCtx["db"] }): Promise<"direct" | "partner"> {
  const row = await ctx.db
    .query("systemConfig")
    .withIndex("by_key", (q) => q.eq("key", "payment_route"))
    .first();
  return row?.value === 1 ? "partner" : "direct";
}

/** The active approved provider, if one is configured. */
export async function getActivePartner(ctx: { db: QueryCtx["db"] }): Promise<Doc<"remittancePartners"> | null> {
  const all = await ctx.db.query("remittancePartners").take(50);
  return all.find((p) => p.active) ?? null;
}

export async function resolveRailMode(ctx: MutationCtx): Promise<"live" | "sandbox" | "unavailable"> {
  const live = (await getSystemValue(ctx, "rail_mode", 0)) === 1;
  if (live) return "live";
  return sandboxModeEnabled() ? "sandbox" : "unavailable";
}

// ============================================================================
// FEE ENGINE — pricing is centralised in the pricing service (pricing.ts) and
// the shared engine (src/lib/pricing.ts). Rates are administrator-configured
// tiers; nothing about pricing is hard-coded in this flow.
// ============================================================================

/** Read a numeric system flag (e.g. rail_mode) — configuration over code. */
async function getSystemValue(ctx: MutationCtx, key: string, fallback: number): Promise<number> {
  const row = await ctx.db
    .query("systemConfig")
    .withIndex("by_key", (q) => q.eq("key", key))
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
    // Event-feed record only: no outbound employer webhook delivery exists
    // yet, so never claim "delivered".
    status: "recorded",
    createdAt: Date.now(),
  });
}

// Reference generation uses the shared CSPRNG helper (src/lib/security.ts).

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
      .take(10_000);
    const batch = batches.find(
      (b) => b.contributionYear === year && b.contributionMonth === month && b.status !== "failed",
    );
    if (!batch) return null;

    const records = await ctx.db
      .query("contributionRecords")
      .withIndex("by_batch", (q) => q.eq("batchId", batch._id))
      .take(10_000);

    const valid = records.filter((r) => r.validationStatus === "valid");
    const employeeSum = valid.reduce((s, r) => s + r.employeeContribution, 0);
    const employerSum = valid.reduce((s, r) => s + r.employerContribution, 0);
    const pension = employeeSum + employerSum;
    const quote = await quoteForEmployer(ctx, employer._id, valid.length);
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
    const payment = await getActivePayment(ctx, batchId);
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
    if (!user) throw new ConvexError("Not authenticated");
    const employer = await getEmployerForEngine(ctx, user);
    if (!employer) throw new ConvexError("No employer profile. Complete onboarding first.");
    if (employer.status !== "active" || employer.kycStatus !== "verified") throw new ConvexError("Employer account must be approved before submitting contributions.");
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
    // Present the key to the indexed SHA-256 column — raw keys are never
    // stored after generation. Legacy plaintext keys keep working and are
    // upgraded in place on first successful use (no silent invalidation).
    const presentedHash = await hashApiKey(apiKey);
    let employer = await ctx.db
      .query("employers")
      .withIndex("by_apiKeyHash", (q) => q.eq("apiKeyHash", presentedHash))
      .first();
    const legacyKey = employer ? false : true;
    if (!employer) {
      employer = await ctx.db
        .query("employers")
        .filter((q) => q.eq(q.field("apiKey"), apiKey))
        .first();
    }
    if (!employer) {
      return { ok: false as const, status: 401, error: "Invalid API key" };
    }
    if (employer.status !== "active" || employer.kycStatus !== "verified") {
      return { ok: false as const, status: 403, error: "Employer account is not approved for contribution intake" };
    }
    // Durable, database-backed sliding window: 30 intake attempts / minute.
    const now = Date.now();
    const windowStart = employer.intakeWindowStart ?? 0;
    const inWindow = now - windowStart < 60_000;
    const attempt = inWindow ? (employer.intakeCount ?? 0) + 1 : 1;
    if (attempt > 30) {
      return { ok: false as const, status: 429, error: "Too many intake requests — retry in a minute" };
    }
    await ctx.db.patch(employer._id, {
      intakeCount: attempt,
      intakeWindowStart: inWindow ? windowStart : now,
      // Migration: retire the plaintext copy now that the hash matched.
      ...(legacyKey && employer.apiKey ? { apiKeyHash: presentedHash, apiKey: undefined } : {}),
    });
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
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new ConvexError("Invalid contribution month");
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new ConvexError("Invalid contribution year");
  if (records.length === 0) throw new ConvexError("Cannot submit an empty schedule");
  // Request-size limit for BOTH doors (browser wizard + payroll API).
  if (records.length > 10_000) {
    throw new ConvexError("Schedule too large — maximum 10,000 records per submission");
  }

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
    // SHA-256 over the employer id + canonical schedule. The previous 32-bit
    // FNV hash could collide across tenants, returning ANOTHER employer's
    // batch as a "duplicate" and silently dropping this submission.
    const fingerprint = `fp_${await hashApiKey(`${employer._id};${canonical}`)}`;

    const existing = await ctx.db
      .query("contributionBatches")
      .withIndex("by_fingerprint", (q) => q.eq("fingerprint", fingerprint))
      .first();
    if (existing && existing.employerId === employer._id && existing.status !== "failed") {
      return { duplicate: true as const, batchId: existing._id, batchRef: existing.batchRef };
    }

    // Duplicate-contribution guard: a live batch already exists for this period
    const allBatches = await ctx.db
      .query("contributionBatches")
      .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
      .take(10_000);
    const periodBatch = allBatches.find(
      (b) => b.contributionYear === year && b.contributionMonth === month && b.status !== "failed",
    );
    if (periodBatch) {
      return { duplicate: true as const, batchId: periodBatch._id, batchRef: periodBatch.batchRef };
    }

    // ---- VALIDATION (spec §6, §8) — validate every record, reject nothing silently ----
    const pfas = await ctx.db.query("pfas").collect();
    if (pfas.length === 0) throw new ConvexError("No PFAs configured on the platform");
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

    let batchRef = `BATCH-${year}-${String(month).padStart(2, "0")}-${randRef("", 5)}`;
    // Database-level uniqueness: retry until the reference is free (indexed).
    for (let attempt = 0; attempt < 5; attempt++) {
      const clash = await ctx.db
        .query("contributionBatches")
        .withIndex("by_ref", (q) => q.eq("batchRef", batchRef))
        .first();
      if (!clash) break;
      batchRef = `BATCH-${year}-${String(month).padStart(2, "0")}-${randRef("", 5)}`;
      if (attempt === 4) throw new ConvexError("Could not allocate a unique batch reference — retry");
    }

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
      const finite = (n: number) => Number.isFinite(n) && n >= 0 && n <= MAX_CONTRIBUTION_NAIRA;
      const amountsOk =
        finite(r.employeeContribution) &&
        finite(r.employerContribution) &&
        r.employeeContribution + r.employerContribution > 0;
      // Kobo amounts: each part rounded once; the total is the exact sum of
      // the stored parts so ledger, settlement and reconciliation agree.
      const employeeKobo = finite(r.employeeContribution) ? Math.round(r.employeeContribution * 100) : 0;
      const employerKobo = finite(r.employerContribution) ? Math.round(r.employerContribution * 100) : 0;

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
        employeeContribution: employeeKobo,
        employerContribution: employerKobo,
        totalAmount: employeeKobo + employerKobo,
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
  args: {
    batchId: v.id("contributionBatches"),
    // How the employer pays on the direct route. Card carries the card
    // processing charge (set by the super admin); bank transfer is cheaper.
    method: v.optional(v.union(v.literal("bank"), v.literal("card"))),
  },
  handler: async (ctx, { batchId, method: chosenMethod }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    const employer = await getEmployerForEngine(ctx, user);
    if (!employer) throw new ConvexError("No employer profile");
    if (employer.status !== "active" || employer.kycStatus !== "verified") throw new ConvexError("Employer account must be approved before payment.");

    const batch = await ctx.db.get(batchId);
    if (!batch || batch.employerId !== employer._id) throw new ConvexError("Batch not found");
    if (batch.status !== "awaiting_payment") throw new ConvexError(`Batch is not payable (status: ${batch.status})`);

    const records = await ctx.db
      .query("contributionRecords")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .take(10_000);
    const valid = records.filter((r) => r.validationStatus === "valid");
    if (valid.length === 0) throw new ConvexError("No valid records to pay");

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
    const route = await resolvePaymentRoute(ctx);
    const method: PayMethod = chosenMethod ?? "bank";
    // Gateway processing charge — borne by the employer who picks the method
    // (direct route only; on the partner route the provider sets its own).
    const processingCharge =
      route === "direct" ? processingChargeKobo(pension + fee, method, await readPaymentCharges(ctx)) : 0;
    const totalDebit = pension + fee + processingCharge;

    let paymentRef = randRef("PMT", 8);
    // Database-level uniqueness for the provider-facing reference: a collision
    // could otherwise attach a webhook to the wrong payment (indexed check).
    for (let attempt = 0; attempt < 5; attempt++) {
      const clash = await ctx.db
        .query("payments")
        .withIndex("by_ref", (q) => q.eq("paymentRef", paymentRef))
        .first();
      if (!clash) break;
      paymentRef = randRef("PMT", 8);
      if (attempt === 4) throw new ConvexError("Could not allocate a unique payment reference — retry");
    }
    const idempotencyKey = batch.fingerprint;

    // IDEMPOTENT payment creation — the batch's current attempt (a failed
    // attempt may be retried with a NEW payment and reference).
    const existingPayment = await getActivePayment(ctx, batchId);
    if (existingPayment && existingPayment.status === "successful") {
      return { paymentRef: existingPayment.paymentRef, alreadyPaid: true as const };
    }

    // ---- APPROVED-PROVIDER ROUTE (PenCom PCRS PSSP) ----
    // Penroute never holds the pension money: the employer pays on the
    // partner's platform using Penroute's validated schedule. The payment is
    // recorded "initiated" and only becomes successful when the partner's
    // signed webhook, or a Penroute admin checking the partner's records,
    // confirms it (remittancePartner.ts). Penroute's own service charge is
    // invoiced separately — it is not collected with the pension.
    if (route === "partner") {
      const partner = await getActivePartner(ctx);
      if (!partner) {
        throw new ConvexError(
          "Payments go through an approved provider, but none is configured yet. A platform administrator must set up the provider first.",
        );
      }
      if (
        existingPayment &&
        existingPayment.rail === "pssp_partner" &&
        (existingPayment.status === "initiated" || existingPayment.status === "processing")
      ) {
        return {
          requiresPartner: true as const,
          paymentRef: existingPayment.paymentRef,
          amountKobo: existingPayment.amount,
          partnerName: existingPayment.partnerName ?? partner.name,
          batchId,
        };
      }
      // A Paystack checkout left open from before the switch is superseded.
      if (existingPayment && existingPayment.status === "initiated") {
        await ctx.db.patch(existingPayment._id, {
          status: "failed",
          failureReason: "Replaced: payments now go through the approved provider",
        });
      }
      await ctx.db.insert("payments", {
        batchId,
        employerId: employer._id,
        paymentRef,
        idempotencyKey,
        amount: pension,
        pensionAmount: pension,
        platformFee: fee,
        rail: "pssp_partner",
        status: "initiated",
        initiatedAt: Date.now(),
        partnerCode: partner.code,
        partnerName: partner.name,
        processingCharge: 0,
      });
      await ctx.db.patch(batchId, {
        paymentStatus: "initiated",
        totalEmployeeContribution: employeeSum,
        totalEmployerContribution: employerSum,
        totalPensionAmount: pension,
        platformFee: fee,
        processingCharge: 0,
        totalDebit: pension,
      });
      await audit(ctx, {
        actor: user.email ?? "unknown",
        action: "payment_initiated",
        entityType: "payment",
        entityId: paymentRef,
        employerId: employer._id,
        batchId,
        details: `Remittance of ₦${(pension / 100).toLocaleString()} routed to approved provider ${partner.name}`,
      });
      await webhookEvent(ctx, {
        employerId: employer._id,
        batchId,
        eventType: "payment.initiated",
        payload: JSON.stringify({ paymentRef, amountKobo: pension, rail: "pssp_partner", partner: partner.code }),
      });
      return {
        requiresPartner: true as const,
        paymentRef,
        amountKobo: pension,
        partnerName: partner.name,
        batchId,
      };
    }

    const railMode = await resolveRailMode(ctx);
    if (railMode === "unavailable") {
      throw new ConvexError(
        "No payment rail is configured. A platform administrator must enable the live Paystack payment rail before contributions can be paid.",
      );
    }

    if (railMode === "live") {
      // ---- LIVE RAIL: initiate checkout; confirmation happens in
      // confirmLivePayment → finalizeLivePayment after provider verification ----
      if (existingPayment && (existingPayment.status === "initiated" || existingPayment.status === "processing")) {
        const sameChoice =
          existingPayment.rail === "paystack" &&
          (existingPayment.payMethod ?? "bank") === method &&
          existingPayment.amount === totalDebit;
        if (sameChoice || existingPayment.status === "processing") {
          return {
            requiresCheckout: true as const,
            paymentRef: existingPayment.paymentRef,
            amountKobo: existingPayment.amount,
            payerEmail: employer.contactEmail,
            payMethod: (existingPayment.payMethod ?? "bank") as PayMethod,
            processingChargeKobo: existingPayment.processingCharge ?? 0,
            batchId,
          };
        }
        // Employer switched card ↔ bank transfer (different amount): replace
        // the unpaid checkout. If the old one is somehow paid later, the
        // webhook still records it and supersedes this one (never lost).
        await ctx.db.patch(existingPayment._id, {
          status: "failed",
          failureReason: "Replaced: employer changed the payment method",
        });
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
        payMethod: method,
        processingCharge,
      });
      await ctx.db.patch(batchId, {
        paymentStatus: "initiated",
        totalEmployeeContribution: employeeSum,
        totalEmployerContribution: employerSum,
        totalPensionAmount: pension,
        platformFee: fee,
        processingCharge,
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
        payload: JSON.stringify({ paymentRef, amountKobo: totalDebit, rail: "paystack", method }),
      });
      void paymentId;
      return {
        requiresCheckout: true as const,
        paymentRef,
        amountKobo: totalDebit,
        payerEmail: employer.contactEmail,
        payMethod: method,
        processingChargeKobo: processingCharge,
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
      throw new ConvexError("Payment rail declined the collection");
    }

    const sandboxPaymentId = await ctx.db.insert("payments", {
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
      payMethod: method,
      processingCharge,
    });

    await recordSuccessfulPayment(ctx, {
      batchId,
      paymentId: sandboxPaymentId,
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

/** Shared: write the double-entry ledger + flip the batch to processing.
 *  Exported for the approved-provider confirmation path (remittancePartner.ts). */
export async function recordSuccessfulPayment(
  ctx: Parameters<typeof audit>[0],
  opts: {
    batchId: Id<"contributionBatches">;
    paymentId: Id<"payments">;
    employerId: Id<"employers">;
    employerName: string;
    valid: Doc<"contributionRecords">[];
    feePerEmployee: number;
    paymentRef: string;
    rail: string;
    providerRef?: string;
    actor: string;
  },
) {
  const allPfas = await ctx.db.query("pfas").collect();
  const pfaCodeById = new Map(allPfas.map((p) => [String(p._id), p.code]));

  const employeeSum = opts.valid.reduce((s, r) => s + r.employeeContribution, 0);
  const employerSum = opts.valid.reduce((s, r) => s + r.employerContribution, 0);
  const pension = employeeSum + employerSum;
  const fee = opts.valid.length * opts.feePerEmployee;
  const now = Date.now();

  const payment = await ctx.db.get(opts.paymentId);
  if (!payment || payment.batchId !== opts.batchId) throw new ConvexError("Payment does not belong to this batch");
  // On the approved-provider route the pension went through the partner and
  // Penroute's fee is invoiced separately (not part of this money movement).
  const viaPartner = payment.rail === "pssp_partner";
  const processingCharge = payment.processingCharge ?? 0;
  const collectedFee = viaPartner ? 0 : fee;
  const totalDebit = pension + collectedFee + processingCharge;
  // Any other open checkout attempt for this batch is now superseded.
  const attempts = await ctx.db
    .query("payments")
    .withIndex("by_batch", (q) => q.eq("batchId", opts.batchId))
    .take(100);
  for (const other of attempts) {
    if (other._id !== payment._id && (other.status === "initiated" || other.status === "processing")) {
      await ctx.db.patch(other._id, { status: "failed", failureReason: "Superseded by a confirmed payment for this batch" });
    }
  }

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
    ...(collectedFee > 0
      ? [{ account: "platform_revenue", debit: 0, credit: collectedFee, pfaId: undefined as Id<"pfas"> | undefined, narration: `Penroute processing fee ${opts.valid.length} × ₦${(opts.feePerEmployee / 100).toFixed(2)} (technology/service charge — not a pension contribution)` }]
      : []),
    ...(processingCharge > 0
      ? [{ account: "processing_charge_recovery", debit: 0, credit: processingCharge, pfaId: undefined as Id<"pfas"> | undefined, narration: `${payment.payMethod === "card" ? "Card" : "Payment"} processing charge paid by employer (covers the payment gateway's fee — not revenue, not pension)` }]
      : []),
    { account: "clearing", debit: 0, credit: pension, pfaId: undefined, narration: viaPartner ? `Pension remitted through approved provider ${payment.partnerName ?? ""} ${opts.paymentRef}` : `Pension clearing ${opts.paymentRef}` },
    { account: "clearing", debit: pension, credit: 0, pfaId: undefined, narration: `Pension clearing offset ${opts.paymentRef}` },
  ];
  for (const row of rows) {
    await ctx.db.insert("ledgerEntries", {
      entryRef,
      batchId: opts.batchId,
      paymentId: payment._id,
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

  await ctx.db.patch(payment._id, {
    status: "successful",
    confirmedAt: now,
    providerRef: opts.providerRef ?? payment.providerRef,
  });

  await ctx.db.patch(opts.batchId, {
    paymentStatus: "successful",
    status: "processing",
    paymentRef: opts.paymentRef,
    paymentDate: now,
    totalEmployeeContribution: employeeSum,
    totalEmployerContribution: employerSum,
    totalPensionAmount: pension,
    platformFee: fee,
    processingCharge,
    totalDebit,
  });

  await audit(ctx, {
    actor: opts.actor,
    action: "payment_successful",
    entityType: "payment",
    entityId: opts.paymentRef,
    employerId: opts.employerId,
    batchId: opts.batchId,
    details: `₦${(totalDebit / 100).toLocaleString()} via ${viaPartner ? `approved provider ${payment.partnerName ?? ""}` : opts.rail} (pension ₦${(pension / 100).toLocaleString()}${collectedFee ? ` + fee ₦${(collectedFee / 100).toLocaleString()}` : ""}${processingCharge ? ` + ${payment.payMethod === "card" ? "card" : "processing"} charge ₦${(processingCharge / 100).toLocaleString()}` : ""}${viaPartner && fee ? `; Penroute fee ₦${(fee / 100).toLocaleString()} invoiced separately` : ""})`,
  });
  await webhookEvent(ctx, {
    employerId: opts.employerId,
    batchId: opts.batchId,
    eventType: "payment.successful",
    payload: JSON.stringify({ paymentRef: opts.paymentRef, amountKobo: totalDebit, rail: opts.rail }),
  });

  // Recognise the billing charge as revenue only now that payment is confirmed.
  if (viaPartner) await markChargeInvoiced(ctx, { batchId: opts.batchId, paymentRef: opts.paymentRef });
  else await markChargePaid(ctx, { batchId: opts.batchId, paymentRef: opts.paymentRef });
  await notify(ctx, {
    audience: "employer",
    employerId: opts.employerId,
    kind: "payment_confirmed",
    title: "Payment confirmed",
    body: viaPartner
      ? `${payment.partnerName ?? "The approved provider"} confirmed your remittance of ₦${(totalDebit / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })} (ref ${opts.paymentRef}). You'll be notified when every PFA confirms posting.`
      : `We received ₦${(totalDebit / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })} (ref ${opts.paymentRef}). Contributions are now being remitted to your employees' PFAs; you'll be notified when every PFA confirms posting.`,
    link: "/dashboard/batches",
  });

  // Drive allocation → settlement → reconciliation server-side, so a payment
  // confirmed by webhook (browser closed) never strands the batch.
  await ctx.scheduler.runAfter(0, internal.engine.processPipeline, { batchId: opts.batchId });

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
    if (!payment) throw new ConvexError("Payment not found");
    if (payment.status === "successful") {
      return { ok: true as const, alreadyProcessed: true };
    }
    const batch = await ctx.db.get(payment.batchId);
    if (!batch) throw new ConvexError("Batch not found");
    const employer = await ctx.db.get(payment.employerId);
    const records = await ctx.db
      .query("contributionRecords")
      .withIndex("by_batch", (q) => q.eq("batchId", payment.batchId))
      .take(10_000);
    const valid = records.filter((r) => r.validationStatus === "valid");
    const pensionKobo = valid.reduce((s, r) => s + r.totalAmount, 0);
    const charge = await syncBillingCharge(ctx, {
      batch,
      postingCount: valid.length,
      contributionKobo: pensionKobo,
      actor: "paystack-webhook",
    });
    const feePerEmployee = charge.feePerPostingKobo;

    if (batch.status !== "awaiting_payment") {
      // The batch was already paid through another attempt — never double-book.
      await ctx.db.patch(paymentId, { status: "failed", failureReason: "Duplicate payment for an already-paid batch — refund required" });
      await ctx.db.insert("exceptions", {
        batchId: payment.batchId,
        employerId: payment.employerId,
        exceptionRef: randRef("EXC", 6),
        type: "payment_mismatch",
        description: `Payment ${payment.paymentRef} was confirmed for a batch that is already paid — refund required`,
        amount: payment.amount,
        status: "open",
        responsibleParty: "platform",
        createdAt: Date.now(),
      });
      return { ok: true as const, duplicateBatchPayment: true };
    }
    await recordSuccessfulPayment(ctx, {
      batchId: payment.batchId,
      paymentId: payment._id,
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
    if (!payment || payment.status === "successful" || payment.status === "failed") return { ok: true as const };

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
    await notify(ctx, {
      audience: "employer",
      employerId: payment.employerId,
      kind: "payment_failed",
      title: "Payment not completed",
      body: `Payment ${payment.paymentRef} for ₦${(payment.amount / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })} was not successful (${reason}). No contributions were remitted. You can retry from your dashboard.`,
      link: "/dashboard",
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

// ============================================================================
// STEP 3 — Pipeline: allocate → settle → PFA ack → reconcile → complete
// Idempotent: settlements and acknowledgements are only created if missing, so
// a retry after a mid-pipeline failure resumes without duplicating money
// movement (spec §40).
// ============================================================================

/** Client-safe pipeline resume: the state machine itself is internal, so the
 *  browser can only ask the server to run it — and only for its OWN batch
 *  (admins may resume any). Scheduling happens server-side; clients can never
 *  invoke processPipeline directly. */
export const resumePipeline = mutation({
  args: { batchId: v.id("contributionBatches") },
  handler: async (ctx, { batchId }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    const batch = await ctx.db.get(batchId);
    if (!batch) throw new ConvexError("Batch not found");
    if (user.role !== "admin") {
      const employer = await getEmployerForEngine(ctx, user);
      if (!employer || batch.employerId !== employer._id) throw new ConvexError("Batch not found");
    }
    await audit(ctx, {
      actor: user.email ?? "unknown",
      action: "pipeline_resumed",
      entityType: "batch",
      employerId: batch.employerId,
      batchId,
      details: `Pipeline resume requested for ${batch.batchRef} (status: ${batch.status})`,
    });
    // Only a batch in `processing` can actually advance; anything else is a
    // no-op report so a late retry (already completed) never errors or
    // double-runs the state machine.
    if (batch.status === "processing") {
      await ctx.scheduler.runAfter(0, internal.engine.processPipeline, { batchId });
    }
    return { ok: true as const, status: batch.status };
  },
});

export const processPipeline = internalMutation({
  args: { batchId: v.id("contributionBatches") },
  handler: async (ctx, { batchId }) => {
    const batch = await ctx.db.get(batchId);
    if (!batch) throw new ConvexError("Batch not found");
    // Several triggers may schedule this (payment confirmation, browser
    // resume, PFA dispatch loop, settlement confirmation). Anything not in
    // `processing` is already finished or not yet paid: a harmless no-op.
    if (batch.status !== "processing") return { status: batch.status, skipped: true as const };
    const sandbox = sandboxModeEnabled();

    const now = Date.now();

    // ---- ALLOCATION ENGINE: route each record to its PFA ----
    const records = await ctx.db
      .query("contributionRecords")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .take(10_000);
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
    const payment = await getActivePayment(ctx, batchId);
    if (!payment || payment.status !== "successful") throw new ConvexError("Confirmed payment missing for batch");

    const existingSettlements = await ctx.db
      .query("settlements")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .take(10_000);
    // Settlement entries: existing docs, or the lightweight instruction we just
    // inserted (id + ref, without a status field yet on this in-memory copy).
    type SettlementEntry =
      | Doc<"settlements">
      | {
          _id: Id<"settlements">;
          pfaId: Id<"pfas">;
          amount: number;
          count: number;
          settlementRef: string;
        };
    const settlementByPfa = new Map<string, SettlementEntry>(
      existingSettlements.map((s) => [String(s.pfaId), s]),
    );

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
        settlementByPfa.set(key, { ...g, _id: liveId, settlementRef });
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
      if (!sandbox) {
        // PRODUCTION, no live PFA integration: the instruction is created and
        // stays PENDING until an authorised PFA operator or platform admin
        // confirms the remittance/posting (settlementOps.confirmSettlement).
        // Nothing is ever reported as settled or posted without that evidence.
        const pendingId = await ctx.db.insert("settlements", {
          batchId,
          paymentId: payment._id,
          pfaId: g.pfaId,
          settlementRef,
          amount: g.amount,
          employeeCount: g.count,
          status: "pending",
          instructedAt: now,
        });
        settlementByPfa.set(key, { ...g, _id: pendingId, settlementRef });
        await notify(ctx, {
          audience: "pfa",
          pfaId: g.pfaId,
          kind: "settlement_awaiting_confirmation",
          title: `Remittance ${settlementRef} awaiting your confirmation`,
          body: `₦${(g.amount / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })} for ${g.count} member(s). Confirm with your posting reference once received and posted.`,
          link: "/pfa/settlements",
          email: false,
        });
        await logIntegration(ctx, {
          adapter: "pfa_manual",
          operation: "settlement_instruction_created",
          requestSummary: `${settlementRef} ₦${(g.amount / 100).toLocaleString()} → PFA (manual confirmation)`,
          responseSummary: "awaiting PFA remittance/posting confirmation",
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
      settlementByPfa.set(key, { ...g, _id: settlementId, settlementRef });
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
      .take(10_000);
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
      // Only live-API PFAs are dispatched automatically; manual/unintegrated
      // PFAs wait for an explicit confirmation.
      if (inFlight.some((s) => pfaMode.get(String(s.pfaId)) === "live_api")) {
        await ctx.scheduler.runAfter(0, internal.pfaDispatch.dispatchLiveSettlements, { batchId });
      }
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
      .take(10_000);
    const ackedSettlements = new Set(existingAcks.map((a) => String(a.settlementId)));

    for (const settlement of finalSettlements) {
      if (settlement.status !== "settled") continue;
      if (ackedSettlements.has(String(settlement._id))) continue; // idempotent resume
      // Live PFAs: the dispatch recorder already wrote the real acknowledgement
      // (received/accepted/posted) — never synthesize one here.
      if (pfaMode.get(String(settlement.pfaId)) === "live_api") continue;
      // Outside sandbox deployments an acknowledgement is only ever written by
      // the confirmation path itself — never synthesised.
      if (!sandbox) continue;

      const ack = pfaAcknowledgeSandbox();
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
    // Per-record status from the PERSISTED settlement rows (re-read above),
    // never from in-memory copies created earlier in this run.
    const persistedByPfa = new Map(finalSettlements.map((x) => [String(x.pfaId), x]));
    for (const r of valid) {
      const settlement = persistedByPfa.get(String(r.pfaId));
      const settlementStatus = settlement?.status;
      const ackStatus = settlement && ackByPfa.get(String(r.pfaId));
      await ctx.db.patch(r._id, {
        settlementStatus: settlement
          ? settlementStatus === "settled"
            ? "settled"
            : "failed"
          : "pending",
        pfaStatus: settlementStatus === "settled" ? (ackStatus ?? "awaiting_ack") : "awaiting_ack",
      });
    }
    await ctx.db.patch(batchId, {
      pfaStatus:
        settledSettlements.length === finalSettlements.length && finalSettlements.length > 0
          ? "posted"
          : "awaiting_ack",
    });

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
        await notify(ctx, {
          audience: "admin",
          kind: "reconciliation_mismatch",
          title: `Reconciliation mismatch on ${batch.batchRef}`,
          body: `Payment, settlement and schedule totals disagree (discrepancy ₦${(discrepancy / 100).toLocaleString()}). Investigate in the admin console.`,
          link: "/admin",
        });
      }
    }

    const ledgerRows = await ctx.db
      .query("ledgerEntries")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .take(10_000);
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
      await notify(ctx, {
        audience: "employer",
        employerId: batch.employerId,
        kind: "batch_completed",
        title: `Contributions posted — ${batch.contributionYear}-${String(batch.contributionMonth).padStart(2, "0")}`,
        body: `Every PFA confirmed posting for ${batch.batchRef} and the batch is reconciled. Your payment certificate is available under Pension Payments.`,
        link: "/dashboard/batches",
      });
    }
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
