/**
 * ============================================================================
 * GITHUB SYNC — data access (Convex runtime, no Node)
 * ----------------------------------------------------------------------------
 * Staging + status queries/mutations backing the GitHub push action
 * (githubSync.ts, which runs in Node for outbound HTTPS calls).
 * ============================================================================
 */
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { GITHUB_MANIFEST } from "../lib/github-manifest.generated";
import { getCurrentUser } from "./users";

/** Admin-only gate: pushing source to the operator's GitHub repository is a
 *  privileged action — anonymous visitors and non-admin users are rejected
 *  before anything is staged. */
async function requireAdminUser(ctx: QueryCtx | MutationCtx) {
  const user = await getCurrentUser(ctx);
  if (!user) throw new Error("Not authenticated");
  if (user.role !== "admin") throw new Error("Admin access required");
  return user;
}

async function stagePushImpl(ctx: MutationCtx, pushId: string) {
    const files = GITHUB_MANIFEST;
    // Fresh stage for this pushId (clear any previous attempt)
    const old = await ctx.db
      .query("githubPushFiles")
      .withIndex("by_push", (q) => q.eq("pushId", pushId))
      .take(10_000);
    for (const row of old) await ctx.db.delete(row._id);
    const now = Date.now();
    for (const f of files) {
      await ctx.db.insert("githubPushFiles", {
        pushId,
        path: f.path,
        contentBase64: f.contentBase64,
        sha256: f.sha256,
        bytes: f.bytes,
        status: "staged",
        createdAt: now,
      });
    }
  return { staged: files.length, totalBytes: files.reduce((s, f) => s + f.bytes, 0) };
}

/** Stage the generated manifest into the database for the push action.
 *  Admin-only — see requireAdminUser. */
export const stagePush = mutation({
  args: { pushId: v.string() },
  handler: async (ctx, { pushId }) => {
    await requireAdminUser(ctx);
    return await stagePushImpl(ctx, pushId);
  },
});

/** Trusted operator path (Convex CLI / deployment tooling only — internal
 *  functions are never callable from a browser). Keeps the audited terminal
 *  push workflow working without exposing staging to anonymous clients. */
export const internalStagePush = internalMutation({
  args: { pushId: v.string() },
  handler: async (ctx, { pushId }) => {
    return await stagePushImpl(ctx, pushId);
  },
});

/**
 * Read staged rows page-by-page from the node action (always the first N
 * still-staged). Also returns the bootstrap seed file (README.md preferred)
 * used when the target repository has no commits yet.
 */
export const internalStagedPage = internalQuery({
  args: { pushId: v.string(), limit: v.number() },
  handler: async (ctx, { pushId, limit }) => {
    const rows = await ctx.db
      .query("githubPushFiles")
      .withIndex("by_push", (q) => q.eq("pushId", pushId))
      .take(10_000);
    const staged = rows.filter((r) => r.status === "staged");
    const seed = rows.find((r) => r.path === "README.md") ?? rows[0];
    return {
      page: staged.slice(0, limit).map((r) => ({
        id: r._id,
        path: r.path,
        contentBase64: r.contentBase64,
      })),
      first: seed ? { path: seed.path, contentBase64: seed.contentBase64 } : null,
    };
  },
});

/** Mark rows committed / failed after the push completes. */
export const internalMarkStatus = internalMutation({
  args: { ids: v.array(v.id("githubPushFiles")), status: v.string() },
  handler: async (ctx, { ids, status }) => {
    for (const id of ids) await ctx.db.patch(id, { status });
    return { ok: true };
  },
});

/** Status of a staged push (UI progress display) — admin-only: staged rows
 *  mirror the repository's file list. */
export const githubPushStatus = query({
  args: { pushId: v.string() },
  handler: async (ctx, { pushId }) => {
    await requireAdminUser(ctx);
    const rows = await ctx.db
      .query("githubPushFiles")
      .withIndex("by_push", (q) => q.eq("pushId", pushId))
      .take(10_000);
    const byStatus = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    return { total: rows.length, byStatus };
  },
});
