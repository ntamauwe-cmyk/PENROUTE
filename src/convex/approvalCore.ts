import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { bootstrapAdminEmails } from "./environment";
import type { Doc } from "./_generated/dataModel";
import { audit } from "./employers";
import { notify } from "./notifications";

// ============================================================================
// MAKER-CHECKER for pricing — no single person can change what employers pay.
// An admin PROPOSES a change; it is stored as a pending request and applied
// only when a DIFFERENT admin holding `pricingApprover` authority approves it
// (approvals.ts). Kept in its own module so pricing.ts/admin.ts can propose
// without importing the approval executor (no circular imports).
// ============================================================================

export type PricingChangeKind =
  | "flatFee"
  | "createTier"
  | "updateTier"
  | "setTierActive"
  | "createPlan"
  | "updatePlan"
  | "setPlanActive"
  | "employerRate"
  | "paymentCharges";

const naira = (kobo: unknown) =>
  typeof kobo === "number" ? `₦${(kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}` : "";

/** Plain-language summary shown to the approver. */
async function summarize(ctx: MutationCtx, kind: PricingChangeKind, a: Record<string, unknown>): Promise<string> {
  switch (kind) {
    case "flatFee": {
      const row = await ctx.db
        .query("systemConfig")
        .withIndex("by_key", (q) => q.eq("key", "per_employee_fee_kobo"))
        .first();
      return `Per-employee processing fee ${row ? `${naira(row.value)} → ` : "→ "}${naira(a.perEmployeeFeeKobo)} (applies to every active pricing tier)`;
    }
    case "createTier":
      return `New pricing tier "${a.label}" (${a.minEmployees}${a.maxEmployees ? `–${a.maxEmployees}` : "+"} employees) at ${naira(a.feePerPostingKobo)} per posting`;
    case "updateTier": {
      const t = await ctx.db.get(a.tierId as Doc<"pricingTiers">["_id"]);
      const parts: string[] = [];
      if (a.feePerPostingKobo !== undefined) parts.push(`fee ${t ? `${naira(t.feePerPostingKobo)} → ` : ""}${naira(a.feePerPostingKobo)}`);
      if (a.label !== undefined) parts.push(`label → "${a.label}"`);
      if (a.minEmployees !== undefined || a.maxEmployees !== undefined) {
        parts.push(`range → ${a.minEmployees ?? t?.minEmployees}–${a.maxEmployees ?? "open"}`);
      }
      return `Update tier "${t?.label ?? "?"}": ${parts.join(", ") || "no change"}`;
    }
    case "setTierActive": {
      const t = await ctx.db.get(a.tierId as Doc<"pricingTiers">["_id"]);
      return `${a.active ? "Activate" : "Deactivate"} tier "${t?.label ?? "?"}"`;
    }
    case "createPlan":
      return `New subscription plan "${a.name}" at ${naira(a.monthlyPriceKobo)}/month`;
    case "updatePlan": {
      const pl = await ctx.db.get(a.planId as Doc<"subscriptionPlans">["_id"]);
      return `Update plan "${pl?.name ?? "?"}"${a.monthlyPriceKobo !== undefined ? `: price ${pl ? `${naira(pl.monthlyPriceKobo)} → ` : ""}${naira(a.monthlyPriceKobo)}/month` : ""}${a.name !== undefined ? `, name → "${a.name}"` : ""}`;
    }
    case "employerRate": {
      const e = await ctx.db.get(a.employerId as Doc<"employers">["_id"]);
      return a.feePerPostingKobo === null
        ? `Return ${e?.name ?? "employer"} to standard tier pricing`
        : `Negotiated rate for ${e?.name ?? "employer"}: ${naira(a.feePerPostingKobo)} per employee`;
    }
    case "paymentCharges": {
      const pct = (bps: unknown) => `${(Number(bps) / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 })}%`;
      if (!a.enabled) return "Turn OFF payment processing charges (Penroute absorbs gateway fees)";
      return `Payment processing charges — card: ${pct(a.cardBps)} + ${naira(a.cardFlatKobo)}${Number(a.cardCapKobo) > 0 ? `, max ${naira(a.cardCapKobo)}` : ""}; bank transfer: ${pct(a.bankBps)} + ${naira(a.bankFlatKobo)}${Number(a.bankCapKobo) > 0 ? `, max ${naira(a.bankCapKobo)}` : ""}`;
    }
    case "setPlanActive": {
      const pl = await ctx.db.get(a.planId as Doc<"subscriptionPlans">["_id"]);
      return `${a.active ? "Activate" : "Deactivate"} plan "${pl?.name ?? "?"}"`;
    }
  }
}

export async function proposePricingChange(
  ctx: MutationCtx,
  user: Doc<"users">,
  kind: PricingChangeKind,
  args: Record<string, unknown>,
) {
  const open = await ctx.db
    .query("pricingChangeRequests")
    .withIndex("by_status", (q) => q.eq("status", "pending"))
    .take(200);
  if (open.length >= 50) throw new ConvexError("Too many pricing changes are awaiting approval — resolve some first");
  const payload = JSON.stringify(args);
  if (open.some((r) => r.kind === kind && r.args === payload)) {
    throw new ConvexError("An identical change is already awaiting approval");
  }
  const summary = await summarize(ctx, kind, args);
  const email = user.email ?? "admin";
  const requestId = await ctx.db.insert("pricingChangeRequests", {
    kind,
    args: payload,
    summary,
    status: "pending",
    proposedBy: user._id,
    proposedByEmail: email,
    createdAt: Date.now(),
  });
  await audit(ctx, {
    actor: email,
    action: "pricing_change_proposed",
    entityType: "pricingChangeRequest",
    entityId: requestId,
    details: summary,
  });
  await notify(ctx, {
    audience: "admin",
    kind: "pricing_change_proposed",
    title: "Pricing change awaiting approval",
    body: `${email} proposed: ${summary}. A different admin with fee-approval authority must approve it before it takes effect.`,
    link: "/admin",
  });
  return { pending: true as const, requestId, summary };
}

/**
 * The platform owner is super admin. An account flagged superAdmin is; so is
 * the founding operator (PENROUTE_BOOTSTRAP_ADMIN_EMAILS) on a deployment
 * where no super admin has been recorded yet — the owner never has to "claim"
 * a role to use their own platform. In mutations the flag is persisted.
 */
export async function isSuperAdmin(ctx: QueryCtx | MutationCtx, user: Doc<"users">): Promise<boolean> {
  if (user.role !== "admin") return false;
  if (user.superAdmin) return true;
  if (!bootstrapAdminEmails().has((user.email ?? "").trim().toLowerCase())) return false;
  const users = await ctx.db.query("users").take(10_000);
  const anotherSuper = users.some((u) => u._id !== user._id && u.role === "admin" && u.superAdmin);
  if (anotherSuper) return false;
  if ("insert" in ctx.db) {
    await (ctx as MutationCtx).db.patch(user._id, { superAdmin: true, pricingApprover: true });
  }
  return true;
}
