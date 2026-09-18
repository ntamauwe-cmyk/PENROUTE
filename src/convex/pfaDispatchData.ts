/**
 * ============================================================================
 * PFA DISPATCH — internal data access (V8 runtime, server-only)
 * ============================================================================
 * These internal queries/mutations back the live PFA dispatch action
 * (pfaDispatch.ts, which runs in Node for outbound HTTPS). Internal functions
 * are not callable from the browser — only from server code.
 * ============================================================================
 */
import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";
import { api } from "./_generated/api";

// Self-driving retry loop (spec §40): after every dispatch outcome the
// recorder re-schedules the pipeline, which re-dispatches in-flight
// settlements until PFAs post or the attempt cap stalls the batch with an
// exception (manual resume stays available). Bounded — never an infinite loop.
const MAX_DISPATCH_ATTEMPTS = 20;
const POSTED_RESUME_DELAY_MS = 2_000;
const POLL_RESUME_DELAY_MS = 12_000;

/** In-flight (pending or awaiting-post) settlements for a batch, with attempt counts. */
export const internalPendings = internalQuery({
  args: { batchId: v.id("contributionBatches") },
  handler: async (ctx, { batchId }) => {
    return await ctx.db
      .query("settlements")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .filter((q) => q.or(q.eq(q.field("status"), "pending"), q.eq(q.field("status"), "processing")))
      .collect()
      .then((rows) =>
        rows.map((r) => ({
          _id: r._id,
          settlementRef: r.settlementRef,
          pfaId: r.pfaId,
          status: r.status,
          dispatchAttempts: (r as unknown as { dispatchAttempts?: number }).dispatchAttempts ?? 0,
        })),
      );
  },
});

/** The PFA a settlement belongs to, with its (secret) endpoint config. */
export const internalPfaFor = internalQuery({
  args: { settlementId: v.id("settlements") },
  handler: async (ctx, { settlementId }) => {
    const s = await ctx.db.get(settlementId);
    if (!s) return null;
    const pfa = await ctx.db.get(s.pfaId);
    if (!pfa) return null;
    return { _id: pfa._id, name: pfa.name, code: pfa.code, endpointConfig: pfa.endpointConfig };
  },
});

/** Valid contribution records for one PFA within a batch (the file payload). */
export const internalRecords = internalQuery({
  args: { batchId: v.id("contributionBatches"), pfaId: v.id("pfas") },
  handler: async (ctx, { batchId, pfaId }) => {
    return await ctx.db
      .query("contributionRecords")
      .withIndex("by_pfa_batch", (q) => q.eq("pfaId", pfaId).eq("batchId", batchId))
      .collect()
      .then((rows) =>
        rows
          .filter((r) => r.validationStatus === "valid")
          .map((r) => ({
            employeeCode: r.employeeCode,
            fullName: r.fullName,
            pensionPin: r.pensionPin,
            employeeContribution: r.employeeContribution,
            employerContribution: r.employerContribution,
            totalAmount: r.totalAmount,
          })),
      );
  },
});

/** Batch + employer metadata for the contribution file header. */
export const internalBatchMeta = internalQuery({
  args: { batchId: v.id("contributionBatches") },
  handler: async (ctx, { batchId }) => {
    const b = await ctx.db.get(batchId);
    if (!b) return null;
    const employer = await ctx.db.get(b.employerId);
    return {
      batchRef: b.batchRef,
      contributionMonth: b.contributionMonth,
      contributionYear: b.contributionYear,
      employerName: employer?.name ?? "",
      employerRc: employer?.rcNumber ?? "",
    };
  },
});

/** Admin connection-test lookup. */
export const internalPfaById = internalQuery({
  args: { pfaId: v.id("pfas") },
  handler: async (ctx, { pfaId }) => {
    const pfa = await ctx.db.get(pfaId);
    if (!pfa) return null;
    return { name: pfa.name, code: pfa.code, endpointConfig: pfa.endpointConfig };
  },
});

/**
 * Record the dispatch outcome: settlement status, real PFA acknowledgement,
 * integration log, audit trail. A PFA returning "received"/"processing" is
 * recorded as-is — it is NOT treated as posted.
 */
export const internalRecord = internalMutation({
  args: {
    settlementId: v.id("settlements"),
    ok: v.boolean(),
    status: v.optional(v.string()),
    message: v.optional(v.string()),
    acceptedCount: v.optional(v.number()),
    rejectedCount: v.optional(v.number()),
    failureReason: v.optional(v.string()),
    httpStatus: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement) return;
    const now = Date.now();

    // Every send counts as an attempt (polls included) so the loop is bounded.
    const attempts =
      ((settlement as unknown as { dispatchAttempts?: number }).dispatchAttempts ?? 0) + 1;
    let stillInFlight: boolean;

    if (args.ok) {
      const status = args.status ?? "received";
      const posted = status === "posted" || status === "reconciled";
      const patch: Record<string, unknown> = {
        status: posted ? "settled" : "processing",
        dispatchAttempts: attempts,
      };
      if (posted) patch.confirmedAt = now;
      await ctx.db.patch(args.settlementId, patch);
      stillInFlight = !posted;
      await ctx.db.insert("pfaAcknowledgements", {
        settlementId: args.settlementId,
        batchId: settlement.batchId,
        pfaId: settlement.pfaId,
        status,
        message: args.message,
        acceptedCount: args.acceptedCount,
        rejectedCount: args.rejectedCount,
        receivedAt: now,
      });
    } else {
      // Delivery failed: instruction stays pending for idempotent redelivery.
      await ctx.db.patch(args.settlementId, {
        status: "pending",
        dispatchAttempts: attempts,
        failureReason: `Dispatch attempt ${attempts} failed: ${args.failureReason ?? args.httpStatus ?? "unknown"}`,
      });
      stillInFlight = true;
    }

    await ctx.db.insert("integrationLogs", {
      adapter: "pfa_live",
      operation: "dispatch_settlement",
      requestSummary: `${settlement.settlementRef} → live PFA endpoint`,
      responseSummary: args.ok
        ? `status=${args.status ?? "received"} http=${args.httpStatus ?? 200} ${args.message ?? ""}`.slice(0, 300)
        : `FAILED http=${args.httpStatus ?? "n/a"} ${args.failureReason ?? ""}`.slice(0, 300),
      success: args.ok,
      batchId: settlement.batchId,
      createdAt: now,
    });
    await ctx.db.insert("auditLogs", {
      actor: "system",
      action: args.ok ? "pfa_dispatch_delivered" : "pfa_dispatch_failed",
      entityType: "settlement",
      entityId: settlement.settlementRef,
      batchId: settlement.batchId,
      details: args.ok
        ? `PFA responded "${args.status ?? "received"}" for ${settlement.settlementRef}`
        : `Delivery failed: ${args.failureReason ?? "unknown error"}`,
      createdAt: now,
    });

    // Drive the loop: resume the pipeline until the PFA posts or the cap hits.
    if (stillInFlight) {
      if (attempts < MAX_DISPATCH_ATTEMPTS) {
        const delay = Math.min(POLL_RESUME_DELAY_MS, POSTED_RESUME_DELAY_MS * attempts);
        await ctx.scheduler.runAfter(delay, api.engine.processPipeline, {
          batchId: settlement.batchId,
        });
      } else if (attempts === MAX_DISPATCH_ATTEMPTS) {
        // Cap reached: raise a visible exception; manual resume can retrigger.
        const batch = await ctx.db.get(settlement.batchId);
        if (batch) {
          const openSame = await ctx.db
            .query("exceptions")
            .withIndex("by_batch", (q) => q.eq("batchId", settlement.batchId))
            .filter((q) =>
              q.eq(q.field("description"), `PFA delivery stalled for ${settlement.settlementRef}`),
            )
            .first();
          if (!openSame) {
            await ctx.db.insert("exceptions", {
              batchId: settlement.batchId,
              employerId: batch.employerId,
              pfaId: settlement.pfaId,
              exceptionRef: `EXC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
              type: "settlement_failed",
              description: `PFA delivery stalled for ${settlement.settlementRef}`,
              amount: settlement.amount,
              status: "open",
              responsibleParty: "platform",
              resolutionNotes: `No confirming response after ${attempts} delivery attempts. Verify the PFA endpoint, then resume processing.`,
              createdAt: now,
            });
          }
        }
      }
    }
  },
});

/** Log-only variant for unconfigured PFAs (no status change — stays pending). */
export const internalLog = internalMutation({
  args: { settlementId: v.id("settlements"), ok: v.boolean(), summary: v.string() },
  handler: async (ctx, { settlementId, ok, summary }) => {
    const settlement = await ctx.db.get(settlementId);
    if (!settlement) return;
    await ctx.db.insert("integrationLogs", {
      adapter: "pfa_live",
      operation: "dispatch_skipped",
      requestSummary: settlement.settlementRef,
      responseSummary: summary.slice(0, 300),
      success: ok,
      batchId: settlement.batchId,
      createdAt: Date.now(),
    });
  },
});
