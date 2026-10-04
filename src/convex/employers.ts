import { MutationCtx, QueryCtx, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser } from "./users";

export async function getEmployerForUser(
  ctx: QueryCtx,
  user: { _id: Id<"users">; employerId?: Id<"employers"> },
): Promise<Doc<"employers"> | null> {
  // Resolve only an explicitly linked employer or a workspace owned by this user.
  // Never fall back to a shared active/demo employer: that can cross tenant boundaries.
  if (user.employerId) {
    const linked = await ctx.db.get(user.employerId);
    if (linked && linked.ownerUserId === user._id) return linked;
  }
  return await ctx.db
    .query("employers")
    .withIndex("by_owner", (q) => q.eq("ownerUserId", user._id))
    .first();
}

export async function getCurrentEmployer(ctx: QueryCtx): Promise<Doc<"employers"> | null> {
  const user = await getCurrentUser(ctx);
  if (!user) return null;
  return await getEmployerForUser(ctx, user);
}

/** Records an audit-log row for any action (mutation contexts only). */
export async function audit(
  ctx: MutationCtx,
  entry: {
    actor: string;
    action: string;
    entityType: string;
    entityId?: string;
    employerId?: Id<"employers">;
    batchId?: Id<"contributionBatches">;
    details?: string;
    field?: string;
    before?: string;
    after?: string;
  },
) {
  await ctx.db.insert("auditLogs", { ...entry, createdAt: Date.now() });
}

// ============================================================================
// Payroll/HR API integration keys (spec §4) — generate / revoke
// The key is returned EXACTLY ONCE on generation (like Stripe/GitHub tokens);
// afterwards it is only verifiable server-side by the intake endpoint.
// ============================================================================

/** Cryptographically-strong token (Web Crypto — works in the Convex runtime). */
export function generateApiKeyToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `penr_live_${hex}`;
}

/** An employer may only manage their own API key. */
export async function requireOwnEmployer(ctx: MutationCtx) {
  const user = await getCurrentUser(ctx);
  if (!user) throw new Error("Not authenticated");
  const employer = await getEmployerForUser(ctx, user);
  if (!employer) throw new Error("No employer profile — complete onboarding first");
  return { user, employer };
}

/** Generate (or rotate) this employer's payroll API key. Shown once. */
export const generateApiKey = mutation({
  args: {},
  handler: async (ctx) => {
    const { user, employer } = await requireOwnEmployer(ctx);
    const key = generateApiKeyToken();
    await ctx.db.patch(employer._id, { apiKey: key, apiKeyCreatedAt: Date.now() });
    await audit(ctx, {
      actor: user.email ?? "unknown",
      action: "api_key_generated",
      entityType: "employer",
      entityId: employer._id,
      employerId: employer._id,
      details: "Payroll/HR integration key generated",
    });
    return { apiKey: key };
  },
});

/** Revoke the current payroll API key. */
export const revokeApiKey = mutation({
  args: {},
  handler: async (ctx) => {
    const { user, employer } = await requireOwnEmployer(ctx);
    if (!employer.apiKey) throw new Error("No API key configured");
    await ctx.db.patch(employer._id, { apiKey: undefined, apiKeyCreatedAt: undefined });
    await audit(ctx, {
      actor: user.email ?? "unknown",
      action: "api_key_revoked",
      entityType: "employer",
      entityId: employer._id,
      employerId: employer._id,
      details: "Payroll/HR integration key revoked",
    });
    return { ok: true };
  },
});

/** Whether an API key exists (never the key itself). */
export const getApiKeysStatus = query({
  args: {},
  handler: async (ctx) => {
    const employer = await getCurrentEmployer(ctx);
    if (!employer) return null;
    return { hasKey: Boolean(employer.apiKey), createdAt: employer.apiKeyCreatedAt ?? null };
  },
});
