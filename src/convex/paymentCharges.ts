import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { getCurrentUser } from "./users";
import { audit } from "./employers";
import { isSuperAdmin, proposePricingChange } from "./approvalCore";
import {
  DEFAULT_PAYMENT_CHARGES,
  validatePaymentCharges,
  type PaymentChargeConfig,
} from "../lib/paymentCharges";

// ============================================================================
// PAYMENT PROCESSING CHARGES — the employer who pays by card bears the card
// fee. Stored as systemConfig rows; changed only by the super admin directly,
// or by another admin through maker-checker approval (approvals.ts).
// ============================================================================

const KEYS: Record<keyof PaymentChargeConfig, string> = {
  enabled: "pay_charge_enabled",
  cardBps: "pay_charge_card_bps",
  cardFlatKobo: "pay_charge_card_flat_kobo",
  cardFlatWaiverBelowKobo: "pay_charge_card_waiver_below_kobo",
  cardCapKobo: "pay_charge_card_cap_kobo",
  bankBps: "pay_charge_bank_bps",
  bankFlatKobo: "pay_charge_bank_flat_kobo",
  bankCapKobo: "pay_charge_bank_cap_kobo",
};

export async function readPaymentCharges(ctx: { db: QueryCtx["db"] }): Promise<PaymentChargeConfig> {
  const out = { ...DEFAULT_PAYMENT_CHARGES };
  for (const [field, key] of Object.entries(KEYS) as [keyof PaymentChargeConfig, string][]) {
    const row = await ctx.db
      .query("systemConfig")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (row) {
      if (field === "enabled") out.enabled = row.value === 1;
      else out[field] = row.value;
    }
  }
  return out;
}

/** Current charges — any signed-in user (employers see them before paying). */
export const getPaymentCharges = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    return await readPaymentCharges(ctx);
  },
});

const chargeArgs = {
  enabled: v.boolean(),
  cardBps: v.number(),
  cardFlatKobo: v.number(),
  cardFlatWaiverBelowKobo: v.number(),
  cardCapKobo: v.number(),
  bankBps: v.number(),
  bankFlatKobo: v.number(),
  bankCapKobo: v.number(),
};

/** Applies an approved change (super admin directly, or via approvals). */
export async function apply_paymentCharges(ctx: MutationCtx, a: PaymentChargeConfig, user: { email?: string }) {
  const err = validatePaymentCharges(a);
  if (err) throw new ConvexError(err);
  const before = await readPaymentCharges(ctx);
  const now = Date.now();
  for (const [field, key] of Object.entries(KEYS) as [keyof PaymentChargeConfig, string][]) {
    const value = field === "enabled" ? (a.enabled ? 1 : 0) : (a[field] as number);
    const row = await ctx.db
      .query("systemConfig")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (row) await ctx.db.patch(row._id, { value, updatedAt: now, updatedBy: user.email ?? "admin" });
    else await ctx.db.insert("systemConfig", { key, value, updatedAt: now, updatedBy: user.email ?? "admin" });
  }
  await audit(ctx, {
    actor: user.email ?? "admin",
    action: "update_payment_charges",
    entityType: "systemConfig",
    field: "payment_charges",
    before: JSON.stringify(before),
    after: JSON.stringify(a),
    details: "Payment processing charges updated (card / bank transfer)",
  });
  return { ok: true };
}

export const updatePaymentCharges = mutation({
  args: chargeArgs,
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    if (user.role !== "admin") throw new ConvexError("Admin access required");
    const err = validatePaymentCharges(args);
    if (err) throw new ConvexError(err);
    if (await isSuperAdmin(ctx, user)) {
      return { applied: true as const, result: await apply_paymentCharges(ctx, args, user) };
    }
    return await proposePricingChange(ctx, user, "paymentCharges", args);
  },
});
