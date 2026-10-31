import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser } from "./users";
import { audit, getEmployerForUser } from "./employers";
import { isSuperAdmin } from "./approvalCore";
import { notify } from "./notifications";
import { getActivePartner, recordSuccessfulPayment, resolvePaymentRoute, getActivePayment } from "./engine";
import { syncBillingCharge } from "./billing";
import { isSafePublicHttpsUrl } from "../lib/security";

// ============================================================================
// APPROVED REMITTANCE PROVIDER (PenCom PCRS PSSP) — Penroute as the compliance
// and payroll layer in front of a licensed provider. Penroute never holds the
// pension money on this route:
//   1. Penroute validates the schedule and computes every amount.
//   2. The employer pays on the partner's platform using Penroute's schedule
//      (portal mode), or Penroute submits it to the partner's API (api mode,
//      wired to the partner's own specification once the agreement is signed).
//   3. The payment is confirmed ONLY by the partner's signed webhook
//      (/webhooks/remittance-partner) or by a Penroute administrator who has
//      checked the partner's records — never by the employer's word alone.
// ============================================================================

/** The 11 providers PenCom has approved for the PCRS (as published). */
export const APPROVED_PROVIDERS: { code: string; name: string }[] = [
  { code: "REMITA", name: "Remita (SystemSpecs)" },
  { code: "INTERSWITCH", name: "Interswitch" },
  { code: "NIBSS", name: "NIBSS (Epcoss)" },
  { code: "ETRANZACT", name: "eTranzact" },
  { code: "PAYPEN", name: "Paypen" },
  { code: "PENCENTRAL", name: "Pencentral" },
  { code: "PENSPHERE", name: "Pensphere" },
  { code: "PENREMIT", name: "Penremit" },
  { code: "PENSOL", name: "Pensol" },
  { code: "PENCO", name: "Penco" },
  { code: "AWABAH", name: "Awabah" },
];

async function requireAdmin(ctx: QueryCtx | MutationCtx) {
  const user = await getCurrentUser(ctx);
  if (!user) throw new ConvexError("Not authenticated");
  if (user.role !== "admin") throw new ConvexError("Admin access required");
  return user;
}

async function requireSuper(ctx: MutationCtx) {
  const user = await requireAdmin(ctx);
  if (!(await isSuperAdmin(ctx, user))) {
    throw new ConvexError("Only the super admin can change how payments are routed");
  }
  return user;
}

const publicPartner = (p: Doc<"remittancePartners">) => ({
  _id: p._id,
  code: p.code,
  name: p.name,
  mode: p.mode,
  portalUrl: p.portalUrl,
  apiEndpoint: p.apiEndpoint,
  agreementRef: p.agreementRef,
  active: p.active,
  hasApiSecret: Boolean(p.apiSecret),
  hasWebhookSecret: Boolean(p.webhookSecret),
  updatedAt: p.updatedAt,
  updatedBy: p.updatedBy,
});

// ---------------------------------------------------------------------------
// Admin: configuration
// ---------------------------------------------------------------------------

export const getRouteSettings = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireAdmin(ctx);
    const partners = await ctx.db.query("remittancePartners").take(50);
    return {
      route: await resolvePaymentRoute(ctx),
      canChange: await isSuperAdmin(ctx, user),
      providers: APPROVED_PROVIDERS,
      partners: partners.map(publicPartner),
      webhookPath: "/webhooks/remittance-partner",
    };
  },
});

export const savePartner = mutation({
  args: {
    code: v.string(),
    mode: v.union(v.literal("portal"), v.literal("api")),
    portalUrl: v.optional(v.string()),
    apiEndpoint: v.optional(v.string()),
    apiSecret: v.optional(v.string()), // only sent when changed
    webhookSecret: v.optional(v.string()), // only sent when changed
    agreementRef: v.optional(v.string()),
    makeActive: v.boolean(),
  },
  handler: async (ctx, a) => {
    const user = await requireSuper(ctx);
    const provider = APPROVED_PROVIDERS.find((p) => p.code === a.code);
    if (!provider) throw new ConvexError("Choose one of the PenCom-approved providers");
    const portalUrl = a.portalUrl?.trim() || undefined;
    const apiEndpoint = a.apiEndpoint?.trim() || undefined;
    if (portalUrl && !isSafePublicHttpsUrl(portalUrl)) throw new ConvexError("The provider's portal link must be a public https:// address");
    if (apiEndpoint && !isSafePublicHttpsUrl(apiEndpoint)) throw new ConvexError("The provider's API address must be a public https:// address");
    if (a.mode === "api" && !apiEndpoint) throw new ConvexError("API mode needs the provider's API address");
    for (const s of [a.apiSecret, a.webhookSecret]) {
      if (s !== undefined && s.trim() !== "" && s.trim().length < 16) {
        throw new ConvexError("Secrets from the provider must be at least 16 characters");
      }
    }
    const now = Date.now();
    const existing = await ctx.db
      .query("remittancePartners")
      .withIndex("by_code", (q) => q.eq("code", a.code))
      .first();
    const fields = {
      name: provider.name,
      mode: a.mode,
      portalUrl,
      apiEndpoint,
      agreementRef: a.agreementRef?.trim().slice(0, 120) || undefined,
      updatedAt: now,
      updatedBy: user.email ?? "admin",
      ...(a.apiSecret !== undefined ? { apiSecret: a.apiSecret.trim() || undefined } : {}),
      ...(a.webhookSecret !== undefined ? { webhookSecret: a.webhookSecret.trim() || undefined } : {}),
    };
    let id: Id<"remittancePartners">;
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      id = existing._id;
    } else {
      id = await ctx.db.insert("remittancePartners", { code: a.code, active: false, ...fields });
    }
    if (a.makeActive) {
      for (const p of await ctx.db.query("remittancePartners").take(50)) {
        if (p.active !== (p._id === id)) await ctx.db.patch(p._id, { active: p._id === id });
      }
    }
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: "remittance_partner_saved",
      entityType: "remittancePartner",
      entityId: a.code,
      details: `${provider.name} (${a.mode} mode)${a.makeActive ? " — set as the active provider" : ""}${a.apiSecret !== undefined ? " — API secret updated" : ""}${a.webhookSecret !== undefined ? " — webhook secret updated" : ""}`,
    });
    return { ok: true };
  },
});

export const setPaymentRoute = mutation({
  args: { route: v.union(v.literal("direct"), v.literal("partner")) },
  handler: async (ctx, { route }) => {
    const user = await requireSuper(ctx);
    if (route === "partner") {
      const partner = await getActivePartner(ctx);
      if (!partner) throw new ConvexError("Set up and activate an approved provider first");
      if (!partner.webhookSecret && partner.mode === "api") {
        throw new ConvexError("API mode needs the provider's webhook secret so confirmations can be verified");
      }
    }
    const row = await ctx.db
      .query("systemConfig")
      .withIndex("by_key", (q) => q.eq("key", "payment_route"))
      .first();
    const value = route === "partner" ? 1 : 0;
    const now = Date.now();
    if (row) await ctx.db.patch(row._id, { value, updatedAt: now, updatedBy: user.email ?? "admin" });
    else await ctx.db.insert("systemConfig", { key: "payment_route", value, updatedAt: now, updatedBy: user.email ?? "admin" });
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: "payment_route_changed",
      entityType: "systemConfig",
      field: "payment_route",
      before: row?.value === 1 ? "partner" : "direct",
      after: route,
      details:
        route === "partner"
          ? "Pension remittances now go through the approved provider"
          : "Pension remittances now collected directly through Penroute's Paystack account",
    });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Employer: what to do on the partner route
// ---------------------------------------------------------------------------

/** Route information for the signed-in employer (no secrets). */
export const getEmployerRoute = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const route = await resolvePaymentRoute(ctx);
    const partner = route === "partner" ? await getActivePartner(ctx) : null;
    return {
      route,
      partner: partner ? { name: partner.name, code: partner.code, mode: partner.mode, portalUrl: partner.portalUrl } : null,
    };
  },
});

async function loadOwnPartnerPayment(ctx: QueryCtx | MutationCtx, batchId: Id<"contributionBatches">) {
  const user = await getCurrentUser(ctx);
  if (!user) throw new ConvexError("Not authenticated");
  const batch = await ctx.db.get(batchId);
  if (!batch) throw new ConvexError("Batch not found");
  if (user.role !== "admin") {
    const employer = await getEmployerForUser(ctx, user);
    if (!employer || employer._id !== batch.employerId) throw new ConvexError("Batch not found");
  }
  const payment = await getActivePayment(ctx, batchId);
  return { user, batch, payment };
}

/** The remittance schedule the employer uploads on the provider's platform. */
export const getPartnerSchedule = query({
  args: { batchId: v.id("contributionBatches") },
  handler: async (ctx, { batchId }) => {
    const { batch, payment } = await loadOwnPartnerPayment(ctx, batchId);
    const employer = await ctx.db.get(batch.employerId);
    const records = (
      await ctx.db
        .query("contributionRecords")
        .withIndex("by_batch", (q) => q.eq("batchId", batchId))
        .take(10_000)
    ).filter((r) => r.validationStatus === "valid");
    const pfas = await ctx.db.query("pfas").collect();
    const pfaById = new Map(pfas.map((p) => [String(p._id), p]));
    return {
      paymentRef: payment?.paymentRef ?? null,
      status: payment?.status ?? null,
      partnerName: payment?.partnerName ?? null,
      partnerRef: payment?.partnerRef ?? null,
      declaredAt: payment?.declaredAt ?? null,
      amountKobo: payment?.amount ?? batch.totalPensionAmount,
      employer: { name: employer?.name ?? "", rcNumber: employer?.rcNumber ?? "" },
      month: batch.contributionMonth,
      year: batch.contributionYear,
      batchRef: batch.batchRef,
      rows: records
        .map((r) => ({
          fullName: r.fullName,
          employeeCode: r.employeeCode,
          pensionPin: r.pensionPin,
          pfaCode: pfaById.get(String(r.pfaId))?.code ?? "",
          pfaName: pfaById.get(String(r.pfaId))?.name ?? "",
          employeeKobo: r.employeeContribution,
          employerKobo: r.employerContribution,
          totalKobo: r.totalAmount,
        }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName)),
    };
  },
});

/** Employer records the provider's payment/receipt reference. This does NOT
 *  mark the payment successful — it queues it for confirmation. */
export const declarePartnerPayment = mutation({
  args: { batchId: v.id("contributionBatches"), partnerRef: v.string() },
  handler: async (ctx, { batchId, partnerRef }) => {
    const { user, batch, payment } = await loadOwnPartnerPayment(ctx, batchId);
    const ref = partnerRef.trim();
    if (ref.length < 4 || ref.length > 80 || !/^[A-Za-z0-9._\-/ ]+$/.test(ref)) {
      throw new ConvexError("Enter the reference the provider gave you (letters, numbers, - / . _ only)");
    }
    if (!payment || payment.rail !== "pssp_partner") throw new ConvexError("This contribution is not routed through the approved provider");
    if (payment.status === "successful") throw new ConvexError("This remittance is already confirmed");
    if (payment.status === "failed") throw new ConvexError("This remittance attempt was closed — start the payment again");
    await ctx.db.patch(payment._id, { partnerRef: ref, declaredAt: Date.now(), status: "processing" });
    await ctx.db.patch(batch._id, { paymentStatus: "processing" });
    await audit(ctx, {
      actor: user.email ?? "employer",
      action: "partner_payment_declared",
      entityType: "payment",
      entityId: payment.paymentRef,
      employerId: batch.employerId,
      batchId,
      details: `Employer reports paying ${payment.partnerName ?? "the provider"} — provider ref ${ref}; awaiting confirmation`,
    });
    await notify(ctx, {
      audience: "admin",
      kind: "partner_payment_declared",
      title: "Remittance awaiting provider confirmation",
      body: `${batch.batchRef}: employer reports paying ₦${(payment.amount / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })} on ${payment.partnerName ?? "the provider"} (ref ${ref}). Confirm once the provider's records show it.`,
      link: "/admin",
    });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Confirmation — admin (after checking the provider's records) or webhook
// ---------------------------------------------------------------------------

export const listAwaitingConfirmation = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const rows: Doc<"payments">[] = [];
    for (const status of ["processing", "initiated"]) {
      rows.push(
        ...(await ctx.db
          .query("payments")
          .withIndex("by_rail_status", (q) => q.eq("rail", "pssp_partner").eq("status", status))
          .take(200)),
      );
    }
    const out = [];
    for (const p of rows) {
      const batch = await ctx.db.get(p.batchId);
      const employer = await ctx.db.get(p.employerId);
      out.push({
        paymentId: p._id,
        paymentRef: p.paymentRef,
        status: p.status,
        amountKobo: p.amount,
        partnerName: p.partnerName,
        partnerRef: p.partnerRef,
        declaredAt: p.declaredAt,
        initiatedAt: p.initiatedAt,
        employerName: employer?.name ?? "",
        batchRef: batch?.batchRef ?? "",
        period: batch ? `${batch.contributionMonth}/${batch.contributionYear}` : "",
      });
    }
    return out.sort((a, b) => (b.declaredAt ?? 0) - (a.declaredAt ?? 0) || b.initiatedAt - a.initiatedAt);
  },
});

async function confirmCore(
  ctx: MutationCtx,
  payment: Doc<"payments">,
  opts: { partnerRef?: string; actor: string; confirmedAmountKobo: number },
) {
  if (payment.rail !== "pssp_partner") throw new ConvexError("Not an approved-provider remittance");
  if (payment.status === "successful") return { ok: true as const, alreadyProcessed: true };
  if (payment.status === "failed") throw new ConvexError("This remittance attempt was closed");
  if (opts.confirmedAmountKobo !== payment.amount) {
    throw new ConvexError(
      `The confirmed amount (₦${(opts.confirmedAmountKobo / 100).toLocaleString()}) does not match the schedule (₦${(payment.amount / 100).toLocaleString()}) — resolve with the provider first`,
    );
  }
  const batch = await ctx.db.get(payment.batchId);
  if (!batch) throw new ConvexError("Batch not found");
  if (batch.status !== "awaiting_payment") throw new ConvexError("This contribution is already paid through another attempt");
  const employer = await ctx.db.get(payment.employerId);
  const valid = (
    await ctx.db
      .query("contributionRecords")
      .withIndex("by_batch", (q) => q.eq("batchId", payment.batchId))
      .take(10_000)
  ).filter((r) => r.validationStatus === "valid");
  const charge = await syncBillingCharge(ctx, {
    batch,
    postingCount: valid.length,
    contributionKobo: valid.reduce((s, r) => s + r.totalAmount, 0),
    actor: opts.actor,
  });
  await ctx.db.patch(payment._id, {
    partnerRef: opts.partnerRef ?? payment.partnerRef,
    providerRef: opts.partnerRef ?? payment.partnerRef,
    confirmedBy: opts.actor,
  });
  await recordSuccessfulPayment(ctx, {
    batchId: payment.batchId,
    paymentId: payment._id,
    employerId: payment.employerId,
    employerName: employer?.name ?? "Employer",
    valid,
    feePerEmployee: charge.feePerPostingKobo,
    paymentRef: payment.paymentRef,
    rail: "pssp_partner",
    providerRef: opts.partnerRef ?? payment.partnerRef,
    actor: opts.actor,
  });
  return { ok: true as const };
}

export const confirmPartnerPayment = mutation({
  args: {
    paymentId: v.id("payments"),
    partnerRef: v.string(),
    confirmedAmountKobo: v.number(),
  },
  handler: async (ctx, { paymentId, partnerRef, confirmedAmountKobo }) => {
    const user = await requireAdmin(ctx);
    if (!user.pricingApprover && !(await isSuperAdmin(ctx, user))) {
      throw new ConvexError("Only the super admin or an assigned approver can confirm remittances");
    }
    const payment = await ctx.db.get(paymentId);
    if (!payment) throw new ConvexError("Payment not found");
    const ref = partnerRef.trim();
    if (ref.length < 4) throw new ConvexError("Enter the provider's reference you checked against");
    const res = await confirmCore(ctx, payment, {
      partnerRef: ref,
      actor: `${user.email ?? "admin"} (checked ${payment.partnerName ?? "provider"} records)`,
      confirmedAmountKobo,
    });
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: "partner_payment_confirmed",
      entityType: "payment",
      entityId: payment.paymentRef,
      employerId: payment.employerId,
      batchId: payment.batchId,
      details: `Confirmed against ${payment.partnerName ?? "provider"} records, ref ${ref}`,
    });
    return res;
  },
});

export const rejectPartnerPayment = mutation({
  args: { paymentId: v.id("payments"), reason: v.string() },
  handler: async (ctx, { paymentId, reason }) => {
    const user = await requireAdmin(ctx);
    if (!user.pricingApprover && !(await isSuperAdmin(ctx, user))) {
      throw new ConvexError("Only the super admin or an assigned approver can reject remittances");
    }
    if (!reason.trim()) throw new ConvexError("Give a reason");
    const payment = await ctx.db.get(paymentId);
    if (!payment || payment.rail !== "pssp_partner") throw new ConvexError("Payment not found");
    if (payment.status === "successful") throw new ConvexError("Already confirmed — use a reversal instead");
    await ctx.db.patch(payment._id, { status: "failed", failureReason: reason.trim().slice(0, 300) });
    await ctx.db.patch(payment.batchId, { paymentStatus: "failed" });
    await notify(ctx, {
      audience: "employer",
      employerId: payment.employerId,
      kind: "payment_failed",
      title: "Remittance not confirmed",
      body: `${payment.partnerName ?? "The provider"} has no matching payment for ${payment.paymentRef}: ${reason.trim()}. Nothing was recorded as paid. You can start the payment again from your dashboard.`,
      link: "/dashboard",
    });
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: "partner_payment_rejected",
      entityType: "payment",
      entityId: payment.paymentRef,
      employerId: payment.employerId,
      batchId: payment.batchId,
      details: reason.trim().slice(0, 300),
    });
    return { ok: true };
  },
});

// Webhook plumbing (internal — reached only via the signed HTTP endpoint)
export const getWebhookSecret = internalQuery({
  args: {},
  handler: async (ctx) => (await getActivePartner(ctx))?.webhookSecret ?? null,
});

export const webhookConfirm = internalMutation({
  args: {
    paymentRef: v.string(),
    status: v.string(),
    amountKobo: v.number(),
    partnerRef: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const payment = await ctx.db
      .query("payments")
      .withIndex("by_ref", (q) => q.eq("paymentRef", a.paymentRef))
      .first();
    if (!payment || payment.rail !== "pssp_partner") return { ok: false, reason: "unknown reference" };
    const partner = await getActivePartner(ctx);
    if (!partner || partner.code !== payment.partnerCode) return { ok: false, reason: "not the active provider's payment" };
    if (a.status === "paid") {
      try {
        await confirmCore(ctx, payment, {
          partnerRef: a.partnerRef,
          actor: `${partner.name} (signed webhook)`,
          confirmedAmountKobo: a.amountKobo,
        });
        return { ok: true };
      } catch (e) {
        await ctx.db.insert("exceptions", {
          batchId: payment.batchId,
          employerId: payment.employerId,
          exceptionRef: `EXC-${payment.paymentRef}`,
          type: "payment_mismatch",
          description: `Provider confirmation for ${payment.paymentRef} could not be applied: ${e instanceof Error ? e.message : "error"}`,
          amount: a.amountKobo,
          status: "open",
          responsibleParty: "platform",
          createdAt: Date.now(),
        });
        return { ok: false, reason: "mismatch recorded" };
      }
    }
    if (a.status === "failed" && payment.status !== "successful") {
      await ctx.db.patch(payment._id, { status: "failed", failureReason: `Provider reports failure${a.reason ? `: ${a.reason.slice(0, 200)}` : ""}` });
      await ctx.db.patch(payment.batchId, { paymentStatus: "failed" });
      await notify(ctx, {
        audience: "employer",
        employerId: payment.employerId,
        kind: "payment_failed",
        title: "Remittance not completed",
        body: `${partner.name} reports the payment for ${payment.paymentRef} failed. Nothing was recorded as paid; you can retry from your dashboard.`,
        link: "/dashboard",
      });
    }
    return { ok: true };
  },
});
