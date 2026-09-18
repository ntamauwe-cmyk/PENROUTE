import { internalMutation, mutation } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";

// ============================================================================
// INTEGRATION ADAPTER LAYER  (spec §13, §14, §15, §38)
// ----------------------------------------------------------------------------
// These are SANDBOX ADAPTERS, clearly labelled as such. They implement the
// exact same contract the approved live PENCOM / PFA / settlement integrations
// will use. Replacing a sandbox adapter with a live one is a configuration
// change on the PFA/PENCOM integration record (integrationMode: sandbox_adapter
// -> live_api) — no rewrite of the platform is required.
//
// The contract of each adapter is deliberately small and explicit:
//   - pfaAdapter.submitSettlementInstruction(...)  -> settlement accepted/ref
//   - pfaAdapter.pollAcknowledgement(...)          -> received/accepted/posted
//   - pencomAdapter.validateEmployer(...)          -> verified/exception
//   - pencomAdapter.validatePensionPin(...)        -> valid/invalid + PFA check
// ============================================================================

export const ADAPTER_LABELS = {
  pfa_sandbox: "PFA Integration — SANDBOX ADAPTER (no live PFA API connected)",
  pencom_sandbox: "PENCOM Integration — SANDBOX ADAPTER (no live PENCOM API connected)",
  settlement_sandbox: "Settlement Rail — SANDBOX ADAPTER (no live payment rail connected)",
} as const;

/**
 * Log an adapter call (auditability of every integration interaction).
 */
export async function logIntegration(
  ctx: MutationCtx,
  args: {
    adapter: string;
    operation: string;
    requestSummary: string;
    responseSummary: string;
    success: boolean;
    batchId?: any;
  },
) {
  await ctx.db.insert("integrationLogs", {
    adapter: args.adapter,
    operation: args.operation,
    requestSummary: args.requestSummary,
    responseSummary: args.responseSummary,
    success: args.success,
    batchId: args.batchId,
    createdAt: Date.now(),
  });
}

/**
 * SANDBOX PENCOM adapter — pension PIN validation.
 * Returns whether the PIN is structurally valid + which PFA it maps to.
 * Live replacement: same signature, real PENCOM-approved endpoint.
 */
export function pencomValidatePensionPinSandbox(pin: string, pfaCode: string) {
  const clean = pin.trim().toUpperCase();
  const structurallyValid = /^[A-Z0-9]{6,20}$/.test(clean.replace(/-/g, ""));
  return {
    adapter: "pencom_sandbox" as const,
    operation: "validate_pension_pin",
    valid: structurallyValid && pfaCode.length >= 2,
    reason: structurallyValid
      ? pfaCode.length >= 2
        ? "valid"
        : "unknown_pfa"
      : "invalid_pin_format",
  };
}

/**
 * SANDBOX settlement rail — accepts a settlement instruction.
 * Returns a provider reference; live replacement: NIBSS/bank-approved rail.
 */
export function settlementRailSandboxSubmit(settlementRef: string, amountKobo: number) {
  if (amountKobo <= 0) {
    return { accepted: false, providerRef: null, reason: "invalid_amount" };
  }
  return {
    accepted: true,
    providerRef: `SBX-RAIL-${settlementRef}`,
    reason: "accepted_by_sandbox_rail",
  };
}

/**
 * SANDBOX PFA adapter — PFA acknowledgement of a contribution file.
 * Simulates the PFA responding: received -> accepted -> posted.
 * Live replacement: the PFA's approved API responds with real statuses.
 */
export function pfaAcknowledgeSandbox(settlementRef: string) {
  return {
    status: "posted" as const,
    message: "PFA sandbox: contribution file processed and posted to RSAs",
    acceptedCount: null,
    rejectedCount: null,
  };
}

// ============================================================================
// Mutations used by the payment pipeline (internal, called by engine.ts)
// ============================================================================

export const recordIntegrationCall = internalMutation({
  args: {
    adapter: v.string(),
    operation: v.string(),
    requestSummary: v.string(),
    responseSummary: v.string(),
    success: v.boolean(),
    batchId: v.optional(v.id("contributionBatches")),
  },
  handler: async (ctx, args) => {
    await logIntegration(ctx, args);
  },
});

/**
 * Debug/dev helper: manually exercise the sandbox adapters from the UI
 * (Admin → Integrations) so reviewers can verify the adapter layer works.
 */
export const testAdapters = mutation({
  args: {
    pin: v.string(),
    pfaCode: v.string(),
    amountKobo: v.number(),
  },
  handler: async (ctx, args) => {
    const pinResult = pencomValidatePensionPinSandbox(args.pin, args.pfaCode);
    const railResult = settlementRailSandboxSubmit("TEST-" + Date.now(), args.amountKobo);
    const ackResult = pfaAcknowledgeSandbox("TEST-" + Date.now());
    await logIntegration(ctx, {
      adapter: "pencom_sandbox",
      operation: "validate_pension_pin",
      requestSummary: `pin=${args.pin} pfa=${args.pfaCode}`,
      responseSummary: JSON.stringify(pinResult),
      success: pinResult.valid,
    });
    return { pinResult, railResult, ackResult };
  },
});
