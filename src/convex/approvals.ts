import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { getCurrentUser } from "./users";
import { audit } from "./employers";
import { notify } from "./notifications";
import { isSuperAdmin, type PricingChangeKind } from "./approvalCore";
import { bootstrapAdminEmails } from "./environment";
import {
  apply_createPlan,
  apply_employerRate,
  apply_createTier,
  apply_setPlanActive,
  apply_setTierActive,
  apply_updatePlan,
  apply_updateTier,
} from "./pricing";
import { apply_flatFee } from "./admin";
import { apply_paymentCharges } from "./paymentCharges";

// ============================================================================
// PRICING APPROVALS — the checker side of maker-checker. Only an admin with
// `pricingApprover` authority, who did NOT propose the change, may approve.
// The proposer may cancel their own pending request.
// ============================================================================

async function requireAdmin(ctx: Parameters<typeof getCurrentUser>[0]) {
  const user = await getCurrentUser(ctx);
  if (!user) throw new ConvexError("Not authenticated");
  if (user.role !== "admin") throw new ConvexError("Admin access required");
  return user;
}

async function execute(ctx: MutationCtx, kind: PricingChangeKind, a: never, actor: { email: string }) {
  switch (kind) {
    case "flatFee":
      return apply_flatFee(ctx, a, actor);
    case "createTier":
      return apply_createTier(ctx, a, actor);
    case "updateTier":
      return apply_updateTier(ctx, a, actor);
    case "setTierActive":
      return apply_setTierActive(ctx, a, actor);
    case "createPlan":
      return apply_createPlan(ctx, a, actor);
    case "updatePlan":
      return apply_updatePlan(ctx, a, actor);
    case "setPlanActive":
      return apply_setPlanActive(ctx, a, actor);
    case "employerRate":
      return apply_employerRate(ctx, a, actor);
    case "paymentCharges":
      return apply_paymentCharges(ctx, a, actor);
    default:
      throw new ConvexError("Unknown pricing change");
  }
}

export const listPricingRequests = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireAdmin(ctx);
    const pending = await ctx.db
      .query("pricingChangeRequests")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("desc")
      .take(100);
    const recent = (await ctx.db.query("pricingChangeRequests").order("desc").take(30)).filter(
      (r) => r.status !== "pending",
    );
    const sup = await isSuperAdmin(ctx, user);
    const tag = (r: (typeof pending)[number]) => ({
      ...r,
      mine: r.proposedBy === user._id,
      // The super admin may approve anything (including their own earlier
      // proposals); assigned approvers never approve their own.
      canApprove: r.status === "pending" && (sup || (Boolean(user.pricingApprover) && r.proposedBy !== user._id)),
    });
    return {
      isApprover: sup || Boolean(user.pricingApprover),
      isSuperAdmin: sup,
      pending: pending.map(tag),
      recent: recent.slice(0, 15).map(tag),
    };
  },
});

export const approvePricingChange = mutation({
  args: { requestId: v.id("pricingChangeRequests"), note: v.optional(v.string()) },
  handler: async (ctx, { requestId, note }) => {
    const user = await requireAdmin(ctx);
    const sup = await isSuperAdmin(ctx, user);
    if (!user.pricingApprover && !sup) {
      throw new ConvexError("Only the super admin or an administrator they assigned can approve pricing changes");
    }
    const req = await ctx.db.get(requestId);
    if (!req) throw new ConvexError("Request not found");
    if (req.status !== "pending") throw new ConvexError(`This change was already ${req.status}`);
    if (req.proposedBy === user._id && !sup) {
      throw new ConvexError("You cannot approve a change you proposed — another approver must approve it");
    }
    const approver = user.email ?? "approver";
    // Audit actor shows BOTH people (maker and checker).
    await execute(ctx, req.kind as PricingChangeKind, JSON.parse(req.args) as never, {
      email: `${req.proposedByEmail} (approved by ${approver})`,
    });
    await ctx.db.patch(requestId, {
      status: "approved",
      decidedBy: user._id,
      decidedByEmail: approver,
      decisionNote: note?.trim().slice(0, 500),
      decidedAt: Date.now(),
    });
    await audit(ctx, {
      actor: approver,
      action: "pricing_change_approved",
      entityType: "pricingChangeRequest",
      entityId: requestId,
      details: `${req.summary} — proposed by ${req.proposedByEmail}`,
    });
    await notify(ctx, {
      audience: "admin",
      kind: "pricing_change_approved",
      title: "Pricing change approved and applied",
      body: `${req.summary} — proposed by ${req.proposedByEmail}, approved by ${approver}.`,
      link: "/admin",
    });
    return { ok: true };
  },
});

export const rejectPricingChange = mutation({
  args: { requestId: v.id("pricingChangeRequests"), note: v.string() },
  handler: async (ctx, { requestId, note }) => {
    const user = await requireAdmin(ctx);
    const req = await ctx.db.get(requestId);
    if (!req) throw new ConvexError("Request not found");
    if (req.status !== "pending") throw new ConvexError(`This change was already ${req.status}`);
    const own = req.proposedBy === user._id;
    if (!own && !user.pricingApprover && !(await isSuperAdmin(ctx, user))) {
      throw new ConvexError("Only the proposer or a fee approver can withdraw or reject this change");
    }
    if (!own && !note.trim()) throw new ConvexError("Give a reason for rejecting the change");
    const status = own ? "cancelled" : "rejected";
    await ctx.db.patch(requestId, {
      status,
      decidedBy: user._id,
      decidedByEmail: user.email ?? "admin",
      decisionNote: note.trim().slice(0, 500) || undefined,
      decidedAt: Date.now(),
    });
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: own ? "pricing_change_cancelled" : "pricing_change_rejected",
      entityType: "pricingChangeRequest",
      entityId: requestId,
      details: `${req.summary}${note.trim() ? ` — ${note.trim().slice(0, 200)}` : ""}`,
    });
    if (!own) {
      await notify(ctx, {
        audience: "admin",
        kind: "pricing_change_rejected",
        title: "Pricing change rejected",
        body: `${req.summary} — rejected by ${user.email ?? "an approver"}: ${note.trim()}`,
        link: "/admin",
      });
    }
    return { ok: true, status };
  },
});

// ============================================================================
// ADMINISTRATOR TEAM — only an admin with fee-approval authority (the higher
// authority) can add/remove administrators or grant/revoke approval
// authority. The person must have signed in to Penroute once.
// ============================================================================

export const listAdmins = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireAdmin(ctx);
    const users = await ctx.db.query("users").take(10_000);
    const sup = await isSuperAdmin(ctx, me);
    const anySuper = sup || users.some((u) => u.role === "admin" && u.superAdmin);
    return {
      canManage: sup,
      // One-time path for deployments created before the super admin existed.
      canClaimApprover: !anySuper && bootstrapAdminEmails().has((me.email ?? "").trim().toLowerCase()),
      admins: users
        .filter((u) => u.role === "admin")
        .map((u) => ({
          _id: u._id,
          email: u.email ?? "(no email)",
          pricingApprover: Boolean(u.pricingApprover || u.superAdmin || (sup && u._id === me._id)),
          superAdmin: Boolean(u.superAdmin || (sup && u._id === me._id)),
          isMe: u._id === me._id,
        }))
        .sort((a, b) => a.email.localeCompare(b.email)),
    };
  },
});

export const setAdminAccess = mutation({
  args: {
    email: v.string(),
    admin: v.boolean(),
    pricingApprover: v.boolean(),
  },
  handler: async (ctx, { email, admin, pricingApprover }) => {
    const me = await requireAdmin(ctx);
    if (!(await isSuperAdmin(ctx, me))) {
      throw new ConvexError("Only the super admin can manage administrators and approval authority");
    }
    const norm = email.trim().toLowerCase();
    const target = (await ctx.db.query("users").withIndex("email", (q) => q.eq("email", norm)).take(10)).find(
      (u) => !u.isAnonymous,
    );
    if (!target) throw new ConvexError(`${norm} has not signed in to Penroute yet — ask them to sign in once first`);
    if (target.role === "pfa") throw new ConvexError("This account is a PFA portal operator and cannot be an administrator");
    if (!admin && pricingApprover) throw new ConvexError("Approval authority requires administrator access");
    if (target._id === me._id || target.superAdmin) {
      throw new ConvexError("The super admin's own access cannot be changed here");
    }
    const before = `${target.role ?? "user"}${target.pricingApprover ? "+approver" : ""}`;
    await ctx.db.patch(target._id, {
      role: admin ? "admin" : target.employerId ? "user" : undefined,
      pricingApprover: admin ? pricingApprover : false,
    });
    await audit(ctx, {
      actor: me.email ?? "admin",
      action: "admin_access_changed",
      entityType: "user",
      entityId: target._id,
      field: "role",
      before,
      after: `${admin ? "admin" : "user"}${admin && pricingApprover ? "+approver" : ""}`,
      details: `${norm}: ${admin ? (pricingApprover ? "administrator with fee-approval authority" : "administrator") : "administrator access removed"}`,
    });
    return { ok: true };
  },
});

/** One-time: the founding operator (PENROUTE_BOOTSTRAP_ADMIN_EMAILS) becomes
 *  super admin on a deployment where none exists yet. */
export const claimApproverAuthority = mutation({
  args: {},
  handler: async (ctx) => {
    const me = await requireAdmin(ctx);
    if (!bootstrapAdminEmails().has((me.email ?? "").trim().toLowerCase())) {
      throw new ConvexError("Only the founding operator account can claim approval authority");
    }
    const users = await ctx.db.query("users").take(10_000);
    if (users.some((u) => u.role === "admin" && u.superAdmin)) {
      throw new ConvexError("A super admin already exists");
    }
    await ctx.db.patch(me._id, { pricingApprover: true, superAdmin: true });
    await audit(ctx, {
      actor: me.email ?? "admin",
      action: "super_admin_claimed",
      entityType: "user",
      entityId: me._id,
      details: "Founding operator became super admin (none existed)",
    });
    return { ok: true };
  },
});
