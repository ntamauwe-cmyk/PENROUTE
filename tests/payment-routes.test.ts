import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/convex/_generated/api";
import type { Id } from "../src/convex/_generated/dataModel";
import { approvedEmployer, ensureAdmin, newBackend, resetAdminCache, schedule, seedPfas, signedInAs, type Backend } from "./helpers";
import { DEFAULT_PAYMENT_CHARGES, processingChargeKobo } from "../src/lib/paymentCharges";

const PAYSTACK_KEY = "sk_test_penroute_integration_suite_0000000000";
const WEBHOOK_SECRET = "remita-shared-webhook-secret-0001";

async function hmac256(secret: string, body: string) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ledger = (t: Backend, batchId: Id<"contributionBatches">) =>
  t.run(async (ctx) => ctx.db.query("ledgerEntries").withIndex("by_batch", (q) => q.eq("batchId", batchId)).collect());
const payments = (t: Backend, batchId: Id<"contributionBatches">) =>
  t.run(async (ctx) => ctx.db.query("payments").withIndex("by_batch", (q) => q.eq("batchId", batchId)).collect());

async function superAdmin(t: Backend) {
  const a = await signedInAs(t, { email: "owner@penroute.test", role: "admin" });
  await t.run((ctx) => ctx.db.patch(a.userId, { superAdmin: true, pricingApprover: true }));
  return a;
}

let t: Backend;
beforeEach(async () => {
  vi.useFakeTimers();
  resetAdminCache();
  t = newBackend();
  await seedPfas(t);
  vi.stubEnv("PAYSTACK_SECRET_KEY", PAYSTACK_KEY);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("processing charge calculation", () => {
  test("card: 1.5% + ₦100, ₦100 waived under ₦2,500, capped at ₦2,000; bank transfer free by default", () => {
    const c = DEFAULT_PAYMENT_CHARGES;
    expect(processingChargeKobo(200_000, "card", c)).toBe(3_000); // ₦2,000 → ₦30
    expect(processingChargeKobo(1_000_000, "card", c)).toBe(25_000); // ₦10,000 → ₦150 + ₦100
    expect(processingChargeKobo(50_000_000, "card", c)).toBe(200_000); // capped ₦2,000
    expect(processingChargeKobo(50_000_000, "bank", c)).toBe(0);
    expect(processingChargeKobo(50_000_000, "card", { ...c, enabled: false })).toBe(0);
  });
});

describe("card charge is paid by the employer", () => {
  async function liveBatch() {
    const admin = await ensureAdmin(t);
    await admin.client.mutation(api.admin.adminSetRailMode, { mode: "live" });
    const emp = await approvedEmployer(t, "fin@acme.test", "RC-3001");
    const { batchId } = await emp.client.mutation(api.engine.prepareBatch, { year: 2026, month: 9, records: schedule(6) });
    return { emp, batchId };
  }

  test("card adds the charge to the amount; switching to bank transfer replaces the checkout without it", async () => {
    const { emp, batchId } = await liveBatch();
    const card = await emp.client.mutation(api.engine.payBatch, { batchId, method: "card" });
    if (!("requiresCheckout" in card)) throw new Error("expected checkout");
    expect(card.payMethod).toBe("card");
    expect(card.processingChargeKobo).toBeGreaterThan(0);
    const bank = await emp.client.mutation(api.engine.payBatch, { batchId, method: "bank" });
    if (!("requiresCheckout" in bank)) throw new Error("expected checkout");
    expect(bank.processingChargeKobo).toBe(0);
    expect(card.amountKobo - bank.amountKobo).toBe(card.processingChargeKobo);
    expect(bank.paymentRef).not.toBe(card.paymentRef);
    const ps = await payments(t, batchId);
    expect(ps.find((p) => p.paymentRef === card.paymentRef)?.status).toBe("failed");
    expect(ps.find((p) => p.paymentRef === bank.paymentRef)?.status).toBe("initiated");
    // Same method again → same checkout (idempotent).
    const again = await emp.client.mutation(api.engine.payBatch, { batchId, method: "bank" });
    if (!("requiresCheckout" in again)) throw new Error("expected checkout");
    expect(again.paymentRef).toBe(bank.paymentRef);
  });

  test("a confirmed card payment books the charge as recovery (not revenue) and the ledger balances", async () => {
    const { emp, batchId } = await liveBatch();
    const res = await emp.client.mutation(api.engine.payBatch, { batchId, method: "card" });
    if (!("requiresCheckout" in res)) throw new Error("expected checkout");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const ref = decodeURIComponent(String(url).split("/").pop() ?? "");
        return new Response(JSON.stringify({ status: true, data: { reference: ref, currency: "NGN", fees: 0, status: "success", amount: res.amountKobo } }), { status: 200 });
      }),
    );
    await emp.client.action(api.payments.confirmLivePayment, { batchId });
    const rows = await ledger(t, batchId);
    const recovery = rows.filter((r) => r.account === "processing_charge_recovery");
    expect(recovery).toHaveLength(1);
    expect(recovery[0].credit).toBe(res.processingChargeKobo);
    expect(rows.reduce((s, r) => s + r.debit, 0)).toBe(rows.reduce((s, r) => s + r.credit, 0));
    expect(rows.find((r) => r.account === "employer_debit")?.debit).toBe(res.amountKobo);
    const b = await t.run((ctx) => ctx.db.get(batchId));
    expect(b?.processingCharge).toBe(res.processingChargeKobo);
    expect(b?.totalDebit).toBe(res.amountKobo);
  });

  test("only the super admin sets charges directly; another admin's change waits for approval", async () => {
    const sup = await superAdmin(t);
    const ops = await signedInAs(t, { email: "ops@penroute.test", role: "admin" });
    const cfg = { ...DEFAULT_PAYMENT_CHARGES, cardBps: 200 };
    const p = await ops.client.mutation(api.paymentCharges.updatePaymentCharges, cfg);
    expect("pending" in p).toBe(true);
    expect((await ops.client.query(api.paymentCharges.getPaymentCharges, {}))?.cardBps).toBe(150);
    if (!("pending" in p)) throw new Error();
    await sup.client.mutation(api.approvals.approvePricingChange, { requestId: p.requestId });
    expect((await ops.client.query(api.paymentCharges.getPaymentCharges, {}))?.cardBps).toBe(200);
    const direct = await sup.client.mutation(api.paymentCharges.updatePaymentCharges, { ...cfg, bankFlatKobo: 5_000 });
    expect("applied" in direct).toBe(true);
    await expect(sup.client.mutation(api.paymentCharges.updatePaymentCharges, { ...cfg, cardBps: 5_000 })).rejects.toThrow(/10%/);
  });
});

describe("approved provider (PSSP) route", () => {
  async function partnerSetup() {
    const sup = await superAdmin(t);
    await expect(sup.client.mutation(api.remittancePartner.setPaymentRoute, { route: "partner" })).rejects.toThrow(/provider/);
    await sup.client.mutation(api.remittancePartner.savePartner, {
      code: "REMITA",
      mode: "portal",
      portalUrl: "https://remita.net",
      webhookSecret: WEBHOOK_SECRET,
      agreementRef: "REMITA/PEN/2026/014",
      makeActive: true,
    });
    await sup.client.mutation(api.remittancePartner.setPaymentRoute, { route: "partner" });
    const emp = await approvedEmployer(t, "fin@beta.test", "RC-4001");
    const { batchId } = await emp.client.mutation(api.engine.prepareBatch, { year: 2026, month: 9, records: schedule(6) });
    const res = await emp.client.mutation(api.engine.payBatch, { batchId, method: "card" });
    if (!("requiresPartner" in res)) throw new Error("expected provider handoff");
    return { sup, emp, batchId, ref: res.paymentRef, amount: res.amountKobo };
  }

  test("only the super admin can switch routes", async () => {
    const ops = await signedInAs(t, { email: "ops@penroute.test", role: "admin" });
    await expect(ops.client.mutation(api.remittancePartner.setPaymentRoute, { route: "direct" })).rejects.toThrow(/super admin/);
  });

  test("payment is routed to the provider: pension only, no card charge, nothing paid yet", async () => {
    const { emp, batchId, amount } = await partnerSetup();
    const b = await t.run((ctx) => ctx.db.get(batchId));
    expect(amount).toBe(b!.totalPensionAmount);
    const [p] = await payments(t, batchId);
    expect(p.rail).toBe("pssp_partner");
    expect(p.status).toBe("initiated");
    expect(p.processingCharge).toBe(0);
    expect(await ledger(t, batchId)).toHaveLength(0);
    const sched = await emp.client.query(api.remittancePartner.getPartnerSchedule, { batchId });
    expect(sched.rows).toHaveLength(6);
    expect(sched.partnerName).toBe("Remita (SystemSpecs)");
  });

  test("the employer's reference alone never marks it paid; an admin confirms after checking", async () => {
    const { sup, emp, batchId, amount } = await partnerSetup();
    await emp.client.mutation(api.remittancePartner.declarePartnerPayment, { batchId, partnerRef: "RRR-2803-4411" });
    const [p] = await payments(t, batchId);
    expect(p.status).toBe("processing");
    expect(await ledger(t, batchId)).toHaveLength(0);
    await expect(
      sup.client.mutation(api.remittancePartner.confirmPartnerPayment, { paymentId: p._id, partnerRef: "RRR-2803-4411", confirmedAmountKobo: amount - 1 }),
    ).rejects.toThrow(/does not match/);
    await sup.client.mutation(api.remittancePartner.confirmPartnerPayment, { paymentId: p._id, partnerRef: "RRR-2803-4411", confirmedAmountKobo: amount });
    const rows = await ledger(t, batchId);
    expect(rows.some((r) => r.account === "platform_revenue")).toBe(false);
    expect(rows.reduce((s, r) => s + r.debit, 0)).toBe(rows.reduce((s, r) => s + r.credit, 0));
    const charge = await t.run((ctx) => ctx.db.query("billingCharges").withIndex("by_batch", (q) => q.eq("batchId", batchId)).first());
    expect(charge?.status).toBe("invoiced");
    expect((await t.run((ctx) => ctx.db.get(batchId)))?.status).toBe("processing");
  });

  test("signed provider webhook confirms; forged or wrong-amount calls do not", async () => {
    const { batchId, ref, amount } = await partnerSetup();
    const send = async (body: object, secret = WEBHOOK_SECRET) => {
      const raw = JSON.stringify(body);
      return t.fetch("/webhooks/remittance-partner", {
        method: "POST",
        headers: { "x-penroute-signature": `sha256=${await hmac256(secret, raw)}`, "content-type": "application/json" },
        body: raw,
      });
    };
    expect((await send({ paymentRef: ref, status: "paid", amountKobo: amount }, "wrong-secret-000000000000")).status).toBe(401);
    expect((await payments(t, batchId))[0].status).toBe("initiated");
    await send({ paymentRef: ref, status: "paid", amountKobo: amount + 100 });
    expect((await payments(t, batchId))[0].status).toBe("initiated");
    expect((await t.run((ctx) => ctx.db.query("exceptions").collect())).length).toBe(1);
    const ok = await send({ paymentRef: ref, status: "paid", amountKobo: amount, partnerRef: "RRR-9" });
    expect(ok.status).toBe(200);
    const [p] = await payments(t, batchId);
    expect(p.status).toBe("successful");
    expect(p.partnerRef).toBe("RRR-9");
    // Replay is harmless.
    await send({ paymentRef: ref, status: "paid", amountKobo: amount, partnerRef: "RRR-9" });
    const rows = await ledger(t, batchId);
    expect(rows.filter((r) => r.account === "employer_debit")).toHaveLength(1);
  });
});
