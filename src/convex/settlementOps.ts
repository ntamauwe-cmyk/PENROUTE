import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { getCurrentUser } from "./users";
import { audit } from "./employers";

// ============================================================================
// MANUAL SETTLEMENT CONFIRMATION — the authorised reconciliation path for PFAs
// without a live API integration (integrationMode sandbox_adapter / manual).
//
// In production the pipeline creates one PENDING settlement instruction per
// PFA. It becomes "settled" ONLY when:
//   - a PFA portal operator linked to THAT PFA, or
//   - a platform administrator
// confirms the remittance was received and posted, quoting the PFA/bank
// reference as evidence. The confirmation writes the PFA acknowledgement,
// the audit trail, and re-runs reconciliation for the batch.
// ============================================================================

export const confirmSettlement = mutation({
  args: {
    settlementId: v.id("settlements"),
    reference: v.string(), // PFA posting / bank remittance reference (evidence)
    acceptedCount: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { settlementId, reference, acceptedCount, note }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const settlement = await ctx.db.get(settlementId);
    if (!settlement) throw new Error("Settlement not found");

    const isAdmin = user.role === "admin";
    const isOwnPfa = user.role === "pfa" && user.pfaId === settlement.pfaId;
    if (!isAdmin && !isOwnPfa) throw new Error("Not authorized to confirm this settlement");

    const pfa = await ctx.db.get(settlement.pfaId);
    if (pfa?.integrationMode === "live_api") {
      throw new Error("This PFA is integrated via live API — confirmations arrive automatically from its endpoint");
    }
    if (settlement.status === "settled") throw new Error("Settlement already confirmed");
    if (settlement.status !== "pending" && settlement.status !== "processing") {
      throw new Error(`Settlement cannot be confirmed from status "${settlement.status}"`);
    }
    const ref = reference.trim();
    if (ref.length < 3 || ref.length > 120) {
      throw new Error("Enter the PFA posting or remittance reference (3–120 characters)");
    }
    if (acceptedCount !== undefined && (!Number.isInteger(acceptedCount) || acceptedCount < 0 || acceptedCount > settlement.employeeCount)) {
      throw new Error("Accepted count must be between 0 and the settlement's employee count");
    }
    if (acceptedCount !== undefined && acceptedCount !== settlement.employeeCount) {
      throw new Error(
        "Partial postings must be raised as an exception, not confirmed — confirm only when every employee in the settlement was posted",
      );
    }

    const batch = await ctx.db.get(settlement.batchId);
    if (!batch) throw new Error("Batch not found");
    const now = Date.now();
    const actor = user.email ?? (isAdmin ? "admin" : "pfa-operator");

    await ctx.db.patch(settlementId, { status: "settled", confirmedAt: now, failureReason: undefined });
    await ctx.db.insert("pfaAcknowledgements", {
      settlementId,
      batchId: settlement.batchId,
      pfaId: settlement.pfaId,
      status: "posted",
      message: `Confirmed by ${isAdmin ? "platform admin" : "PFA operator"} ${actor} — ref ${ref}${note ? ` — ${note.slice(0, 300)}` : ""}`,
      acceptedCount: settlement.employeeCount,
      rejectedCount: 0,
      receivedAt: now,
    });
    await ctx.db.insert("integrationLogs", {
      adapter: "pfa_manual",
      operation: "settlement_confirmed",
      requestSummary: `${settlement.settlementRef} ₦${(settlement.amount / 100).toLocaleString()}`,
      responseSummary: `posted — ref ${ref}`.slice(0, 300),
      success: true,
      batchId: settlement.batchId,
      createdAt: now,
    });
    await audit(ctx, {
      actor,
      action: "settlement_confirmed",
      entityType: "settlement",
      entityId: settlement.settlementRef,
      employerId: batch.employerId,
      batchId: settlement.batchId,
      field: "status",
      before: settlement.status,
      after: "settled",
      details: `${pfa?.name ?? "PFA"} confirmed ${settlement.employeeCount} postings, ₦${(settlement.amount / 100).toLocaleString()} — ref ${ref}`,
    });
    // Re-run allocation/reconciliation; it completes the batch once every
    // settlement is confirmed and figures match.
    if (batch.status === "processing") {
      await ctx.scheduler.runAfter(0, internal.engine.processPipeline, { batchId: settlement.batchId });
    }
    return { ok: true as const };
  },
});

/** Settlements awaiting confirmation — admins see all, PFA operators their own. */
export const listAwaitingConfirmation = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    if (user.role !== "admin" && !(user.role === "pfa" && user.pfaId)) {
      throw new Error("Not authorized");
    }
    const rows =
      user.role === "pfa"
        ? await ctx.db
            .query("settlements")
            .withIndex("by_pfa", (q) => q.eq("pfaId", user.pfaId!))
            .take(5_000)
        : await ctx.db.query("settlements").order("desc").take(5_000);
    const open = rows.filter((s) => s.status === "pending" || s.status === "processing");
    const out = [];
    for (const s of open) {
      const [pfa, batch] = await Promise.all([ctx.db.get(s.pfaId), ctx.db.get(s.batchId)]);
      if (!batch || batch.paymentStatus !== "successful") continue;
      if (pfa?.integrationMode === "live_api") continue;
      const employer = await ctx.db.get(batch.employerId);
      out.push({
        _id: s._id,
        settlementRef: s.settlementRef,
        amount: s.amount,
        employeeCount: s.employeeCount,
        instructedAt: s.instructedAt,
        status: s.status,
        pfaName: pfa?.name ?? "Unknown PFA",
        pfaCode: pfa?.code ?? "?",
        batchRef: batch.batchRef,
        period: `${batch.contributionYear}-${String(batch.contributionMonth).padStart(2, "0")}`,
        employerName: employer?.name ?? "—",
      });
    }
    return out.sort((a, b) => a.instructedAt - b.instructedAt);
  },
});
