/**
 * ============================================================================
 * LIVE PAYMENT RAIL ADAPTER — Paystack (production-shaped, spec §38)
 * ============================================================================
 * Same contract as the sandbox rail: the caller gives a reference + amount and
 * gets back { accepted, providerRef?, authorizationUrl?, reason? }.
 *
 * To go live:
 *   1. Add your Paystack SECRET key in the project's Keys tab as
 *      PAYSTACK_SECRET_KEY  (sk_test_xxx to trial, sk_live_xxx for production)
 *   2. Admin console → Platform → switch rail mode to "live"
 *   3. Register the webhook in your Paystack dashboard:
 *      <your deployment URL>/webhooks/paystack
 *   Done. No other code changes.
 *
 * Payment confirmation has two independent paths, both authoritative:
 *   - Paystack webhook (paystackWebhook.ts) — works with the browser closed
 *   - Manual verify (verifyLivePayment) — employer clicks "I've completed payment"
 *
 * This file uses "use node" because it makes outbound HTTPS calls.
 */
"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";

const PAYSTACK_BASE = "https://api.paystack.co";

export const PAYSTACK_ENV_KEY = "PAYSTACK_SECRET_KEY";

/** Detect whether a usable rail key is present (no secret material returned). */
export const railStatus = action({
  args: {},
  handler: async () => {
    const key = process.env.PAYSTACK_SECRET_KEY;
    const mode = !key ? "sandbox" : key.startsWith("sk_live") ? "live" : "sandbox";
    const configured = Boolean(key && key.length > 20);
    return { mode, configured };
  },
});

interface RailResult {
  accepted: boolean;
  providerRef?: string;
  authorizationUrl?: string;
  reason?: string;
}

/** Initialize a Paystack transaction for the consolidated employer payment. */
export const initializeLivePayment = action({
  args: {
    paymentRef: v.string(),
    amountKobo: v.number(),
    email: v.string(),
    callbackUrl: v.optional(v.string()),
  },
  handler: async (_ctx, { paymentRef, amountKobo, email, callbackUrl }): Promise<RailResult> => {
    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key) {
      return { accepted: false, reason: "PAYSTACK_SECRET_KEY is not configured" };
    }
    try {
      const res = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reference: paymentRef,
          amount: amountKobo, // Paystack expects kobo
          email,
          currency: "NGN",
          callbackUrl,
          metadata: { purpose: "pension_contribution", paymentRef },
        }),
      });
      const data = (await res.json()) as {
        status: boolean;
        message?: string;
        data?: { reference: string; authorization_url: string };
      };
      if (!res.ok || !data.status || !data.data) {
        return { accepted: false, reason: data.message ?? `Paystack error ${res.status}` };
      }
      return {
        accepted: true,
        providerRef: data.data.reference,
        authorizationUrl: data.data.authorization_url,
      };
    } catch (e) {
      return {
        accepted: false,
        reason: e instanceof Error ? e.message : "Paystack request failed",
      };
    }
  },
});

/**
 * Verify a Paystack transaction and return the real outcome.
 * Payment is ONLY marked successful when Paystack itself reports success
 * (spec §15: never overstate).
 */
export const verifyLivePayment = action({
  args: { paymentRef: v.string() },
  handler: async (_ctx, { paymentRef }) => {
    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key) {
      return { ok: false as const, reason: "PAYSTACK_SECRET_KEY is not configured" };
    }
    try {
      const res = await fetch(
        `${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(paymentRef)}`,
        { headers: { Authorization: `Bearer ${key}` } },
      );
      const data = (await res.json()) as {
        status: boolean;
        message?: string;
        data?: {
          status: string; // success | failed | abandoned
          amount: number; // kobo
          fees?: number;
          currency: string;
          reference: string;
        };
      };
      if (!res.ok || !data.status || !data.data) {
        return { ok: false as const, reason: data.message ?? `Paystack error ${res.status}` };
      }
      return {
        ok: true as const,
        outcome: data.data.status, // "success" | "failed" | "abandoned"
        amountKobo: data.data.amount,
        providerFeesKobo: data.data.fees ?? 0,
        currency: data.data.currency,
        reference: data.data.reference,
      };
    } catch (e) {
      return {
        ok: false as const,
        reason: e instanceof Error ? e.message : "Paystack verification failed",
      };
    }
  },
});

/**
 * Verify a checkout on the server and finalize only the exact stored payment.
 * The browser supplies a batch ID only; reference, amount and payer are loaded
 * from the authenticated employer's server-side payment record.
 */
export const confirmLivePayment = action({
  args: { batchId: v.id("contributionBatches") },
  handler: async (ctx, { batchId }) => {
    const context = await ctx.runQuery(api.engine.getLivePaymentContext, { batchId });
    if (!context) throw new Error("No authorized pending payment for this batch");
    const payment = await ctx.runQuery(internal.engine.getPaymentByRef, {
      paymentRef: context.paymentRef,
    });
    if (!payment || payment.batchId !== batchId || payment.status === "successful") {
      if (payment?.status === "successful") return { ok: true as const, outcome: "success" as const, alreadyProcessed: true };
      throw new Error("Pending payment record not found");
    }
    if (payment.rail !== "paystack" || payment.amount !== context.expectedKobo) {
      throw new Error("Stored payment details do not match the checkout context");
    }
    const verified = await ctx.runAction(api.payments.verifyLivePayment, {
      paymentRef: payment.paymentRef,
    });
    if (!verified.ok) throw new Error(verified.reason ?? "Paystack verification failed");
    if (verified.outcome !== "success") {
      return { ok: true as const, outcome: verified.outcome };
    }
    if (
      verified.reference !== payment.paymentRef ||
      verified.amountKobo !== payment.amount ||
      verified.currency !== "NGN"
    ) {
      await ctx.runMutation(internal.engine.markLivePaymentFailedSystem, {
        paymentId: payment._id,
        reason: "Paystack verification reference, exact amount, or currency mismatch",
      });
      throw new Error("Payment details do not match the expected amount, currency, or reference");
    }
    await ctx.runMutation(internal.engine.finalizeLivePaymentSystem, {
      paymentId: payment._id,
      providerFeesKobo: verified.providerFeesKobo,
    });
    return {
      ok: true as const,
      outcome: "success" as const,
      amountKobo: verified.amountKobo,
      currency: verified.currency,
    };
  },
});

/** Record a rail integration call in the integration log (auditability). */
export const logRailCall = action({
  args: {
    batchId: v.id("contributionBatches"),
    requestSummary: v.string(),
    responseSummary: v.string(),
    success: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.pension.internalAudit, {
      actor: "system",
      action: "integration_log",
      entityType: "integration",
      batchId: args.batchId,
      details: `rail | ${args.requestSummary} | ${args.responseSummary}`,
    });
  },
});

export type { RailResult };
