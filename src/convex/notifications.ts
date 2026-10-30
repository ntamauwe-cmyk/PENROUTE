import { v } from "convex/values";
import { internalAction, internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { getCurrentUser } from "./users";
import { getEmployerForUser } from "./employers";

// ============================================================================
// NOTIFICATIONS — every important event lands in an in-app inbox for its
// audience (employer workspace, platform admins, or one PFA). Employer
// notifications are also emailed to the employer's contact address when an
// email provider is configured (RESEND_API_KEY + NOTIFY_FROM_EMAIL); without
// it the row records emailStatus "not_configured" — nothing pretends to send.
// ============================================================================

type Audience = "employer" | "admin" | "pfa";

function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.NOTIFY_FROM_EMAIL);
}

function appUrl(): string {
  return (process.env.PENROUTE_APP_URL ?? "https://penroute.net").replace(/\/+$/, "");
}

export async function notify(
  ctx: MutationCtx,
  n: {
    audience: Audience;
    employerId?: Id<"employers">;
    pfaId?: Id<"pfas">;
    kind: string;
    title: string;
    body: string;
    link?: string;
    email?: boolean; // default: true for employer notifications
  },
) {
  let emailTo: string | undefined;
  if (n.audience === "employer" && n.employerId && n.email !== false) {
    const employer = await ctx.db.get(n.employerId);
    emailTo = employer?.contactEmail;
  }
  const wantsEmail = Boolean(emailTo);
  const emailStatus = !wantsEmail ? "none" : emailConfigured() ? "queued" : "not_configured";
  const id = await ctx.db.insert("notifications", {
    audience: n.audience,
    employerId: n.employerId,
    pfaId: n.pfaId,
    kind: n.kind,
    title: n.title.slice(0, 160),
    body: n.body.slice(0, 2000),
    link: n.link,
    emailStatus,
    emailTo,
    createdAt: Date.now(),
  });
  if (emailStatus === "queued") {
    await ctx.scheduler.runAfter(0, internal.notifications.deliverEmail, { notificationId: id });
  }
  return id;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export const getForDelivery = internalMutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, { notificationId }) => {
    const n = await ctx.db.get(notificationId);
    if (!n || n.emailStatus !== "queued" || !n.emailTo) return null;
    return { to: n.emailTo, title: n.title, body: n.body, link: n.link };
  },
});

export const markDelivery = internalMutation({
  args: { notificationId: v.id("notifications"), status: v.string() },
  handler: async (ctx, { notificationId, status }) => {
    await ctx.db.patch(notificationId, { emailStatus: status });
  },
});

/** Sends one notification email through Resend (https://resend.com). */
export const deliverEmail = internalAction({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, { notificationId }) => {
    const n = await ctx.runMutation(internal.notifications.getForDelivery, { notificationId });
    if (!n) return;
    const key = process.env.RESEND_API_KEY;
    const from = process.env.NOTIFY_FROM_EMAIL;
    if (!key || !from) {
      await ctx.runMutation(internal.notifications.markDelivery, { notificationId, status: "not_configured" });
      return;
    }
    const link = n.link ? `${appUrl()}${n.link}` : appUrl();
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;color:#0B1F2A">
<h2 style="color:#007A4D;margin:0 0 12px">${escapeHtml(n.title)}</h2>
<p style="line-height:1.5">${escapeHtml(n.body).replace(/\n/g, "<br>")}</p>
<p><a href="${escapeHtml(link)}" style="background:#007A4D;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open Penroute</a></p>
<p style="font-size:12px;color:#5A6B74">You receive this because your company is registered on Penroute.</p></div>`;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [n.to], subject: `Penroute: ${n.title}`, html, text: `${n.body}\n\n${link}` }),
      });
      await ctx.runMutation(internal.notifications.markDelivery, {
        notificationId,
        status: res.ok ? "sent" : "failed",
      });
      if (!res.ok) console.error(`Notification email failed: HTTP ${res.status}`);
    } catch {
      console.error("Notification email failed: network error");
      await ctx.runMutation(internal.notifications.markDelivery, { notificationId, status: "failed" });
    }
  },
});

/** The signed-in user's inbox (employer workspace, admin, or PFA). */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    if (user.role === "admin") {
      return await ctx.db
        .query("notifications")
        .withIndex("by_audience", (q) => q.eq("audience", "admin"))
        .order("desc")
        .take(50);
    }
    if (user.role === "pfa" && user.pfaId) {
      return await ctx.db
        .query("notifications")
        .withIndex("by_pfa", (q) => q.eq("pfaId", user.pfaId))
        .order("desc")
        .take(50);
    }
    const employer = await getEmployerForUser(ctx, user);
    if (!employer) return [];
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
      .order("desc")
      .take(50);
    return rows.filter((r) => r.audience === "employer");
  },
});

export const markRead = mutation({
  args: { ids: v.array(v.id("notifications")) },
  handler: async (ctx, { ids }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const employer = user.role === "admin" || user.role === "pfa" ? null : await getEmployerForUser(ctx, user);
    const now = Date.now();
    for (const id of ids.slice(0, 100)) {
      const n = await ctx.db.get(id);
      if (!n || n.readAt) continue;
      const mine =
        (n.audience === "admin" && user.role === "admin") ||
        (n.audience === "pfa" && user.role === "pfa" && n.pfaId === user.pfaId) ||
        (n.audience === "employer" && employer && n.employerId === employer._id);
      if (mine) await ctx.db.patch(id, { readAt: now });
    }
    return { ok: true };
  },
});
