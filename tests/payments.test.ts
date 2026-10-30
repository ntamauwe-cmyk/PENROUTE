import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../src/convex/_generated/api";
import type { Id } from "../src/convex/_generated/dataModel";
import {
  approvedEmployer,
  ensureAdmin,
  hmacSha512Hex,
  newBackend,
  resetAdminCache,
  schedule,
  seedPfas,
  signedInAs,
  type Backend,
} from "./helpers";

const PAYSTACK_KEY = "sk_test_penroute_integration_suite_0000000000";

async function ledgerTotals(t: Backend, batchId: Id<"contributionBatches">) {
  return t.run(async (ctx) => {
    const rows = await ctx.db
      .query("ledgerEntries")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .collect();
    return {
      rows: rows.length,
      debit: rows.reduce((s, r) => s + r.debit, 0),
      credit: rows.reduce((s, r) => s + r.credit, 0),
    };
  });
}

async function batchRow(t: Backend, batchId: Id<"contributionBatches">) {
  return t.run(async (ctx) => (await ctx.db.get(batchId))!);
}

async function paymentsFor(t: Backend, batchId: Id<"contributionBatches">) {
  return t.run(async (ctx) =>
    ctx.db.query("payments").withIndex("by_batch", (q) => q.eq("batchId", batchId)).collect(),
  );
}

async function setLiveRail(t: Backend) {
  const admin = await ensureAdmin(t);
  await admin.client.mutation(api.admin.adminSetRailMode, { mode: "live" });
}

async function postWebhook(t: Backend, body: object, signWith = PAYSTACK_KEY) {
  const raw = JSON.stringify(body);
  return t.fetch("/webhooks/paystack", {
    method: "POST",
    headers: { "x-paystack-signature": await hmacSha512Hex(signWith, raw), "content-type": "application/json" },
    body: raw,
  });
}

/** Paystack verify API stub — the only thing faked is Paystack's HTTP reply. */
function stubPaystackVerify(reply: (ref: string) => { status: string; amount: number; currency?: string }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ref = decodeURIComponent(String(url).split("/").pop() ?? "");
      const r = reply(ref);
      return new Response(
        JSON.stringify({ status: true, data: { reference: ref, currency: "NGN", fees: 0, ...r } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
}

let t: Backend;
beforeEach(async () => {
  vi.useFakeTimers();
  resetAdminCache();
  t = newBackend();
  await seedPfas(t);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("production payment rail (no sandbox switch)", () => {
  test("sandbox rail cannot mark a payment successful in a production deployment", async () => {
    const emp = await approvedEmployer(t, "fin@acme.test", "RC-1001");
    const { batchId } = await emp.client.mutation(api.engine.prepareBatch, {
      year: 2026,
      month: 9,
      records: schedule(6),
    });
    await expect(emp.client.mutation(api.engine.payBatch, { batchId })).rejects.toThrow(/payment rail/i);
    expect(await paymentsFor(t, batchId)).toHaveLength(0);
    expect((await ledgerTotals(t, batchId)).rows).toBe(0);
    expect((await batchRow(t, batchId)).paymentStatus).toBe("pending");
  });

  test("admin cannot switch the platform back to the sandbox rail in production", async () => {
    const admin = await ensureAdmin(t);
    await expect(admin.client.mutation(api.admin.adminSetRailMode, { mode: "sandbox" })).rejects.toThrow(
      /sandbox/i,
    );
  });
});

describe("live Paystack rail", () => {
  beforeEach(() => {
    vi.stubEnv("PAYSTACK_SECRET_KEY", PAYSTACK_KEY);
  });

  async function initiated() {
    await setLiveRail(t);
    const emp = await approvedEmployer(t, "fin@acme.test", "RC-2001");
    const { batchId } = await emp.client.mutation(api.engine.prepareBatch, {
      year: 2026,
      month: 9,
      records: schedule(6),
    });
    const res = await emp.client.mutation(api.engine.payBatch, { batchId });
    if (!("requiresCheckout" in res)) throw new Error("expected checkout handoff");
    return { emp, batchId, ref: res.paymentRef, amount: res.amountKobo };
  }

  test("initiating checkout never marks the batch paid or writes the ledger", async () => {
    const { batchId } = await initiated();
    const b = await batchRow(t, batchId);
    expect(b.paymentStatus).toBe("initiated");
    expect(b.status).toBe("awaiting_payment");
    expect((await ledgerTotals(t, batchId)).rows).toBe(0);
    const [p] = await paymentsFor(t, batchId);
    expect(p.status).toBe("initiated");
  });

  test("an abandoned/unfinished Paystack checkout stays pending (not failed, no exception)", async () => {
    const { emp, batchId, amount } = await initiated();
    stubPaystackVerify(() => ({ status: "abandoned", amount }));
    const res = await emp.client.action(api.payments.confirmLivePayment, { batchId });
    expect(res.outcome).toBe("abandoned");
    const [p] = await paymentsFor(t, batchId);
    expect(p.status).toBe("initiated");
    const exc = await t.run((ctx) => ctx.db.query("exceptions").collect());
    expect(exc).toHaveLength(0);
    // The checkout context is still available so the employer can finish paying.
    expect(await emp.client.query(api.engine.getLivePaymentContext, { batchId })).not.toBeNull();
  });

  test("a verified 'failed' outcome is recorded server-side with an exception", async () => {
    const { emp, batchId, amount } = await initiated();
    stubPaystackVerify(() => ({ status: "failed", amount }));
    const res = await emp.client.action(api.payments.confirmLivePayment, { batchId });
    expect(res.outcome).toBe("failed");
    const [p] = await paymentsFor(t, batchId);
    expect(p.status).toBe("failed");
    expect((await batchRow(t, batchId)).paymentStatus).toBe("failed");
    const exc = await t.run((ctx) => ctx.db.query("exceptions").collect());
    expect(exc.map((e) => e.type)).toEqual(["payment_mismatch"]);
  });

  test("webhook: unsigned or wrongly-signed deliveries are rejected and change nothing", async () => {
    const { batchId, ref, amount } = await initiated();
    const body = { event: "charge.success", data: { reference: ref, amount, currency: "NGN", status: "success" } };
    const forged = await postWebhook(t, body, "sk_test_attacker_key_000000000000000000");
    expect(forged.status).toBe(401);
    const unsigned = await t.fetch("/webhooks/paystack", { method: "POST", body: JSON.stringify(body) });
    expect(unsigned.status).toBe(401);
    expect((await paymentsFor(t, batchId))[0].status).toBe("initiated");
    expect((await ledgerTotals(t, batchId)).rows).toBe(0);
  });

  test("webhook: verified charge.success writes a balanced ledger once and drives processing", async () => {
    const { batchId, ref, amount } = await initiated();
    const body = { event: "charge.success", data: { reference: ref, amount, currency: "NGN", status: "success" } };
    const res = await postWebhook(t, body);
    expect(res.status).toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const p = (await paymentsFor(t, batchId))[0];
    expect(p.status).toBe("successful");
    const ledger = await ledgerTotals(t, batchId);
    expect(ledger.rows).toBeGreaterThan(0);
    expect(ledger.debit).toBe(ledger.credit);

    // Replay (Paystack retries deliveries) is a no-op.
    expect((await postWebhook(t, body)).status).toBe(200);
    expect((await ledgerTotals(t, batchId)).rows).toBe(ledger.rows);

    // The pipeline ran without the browser: funds are allocated and PFA
    // settlement instructions exist — but with no live/confirmed PFA
    // settlement, nothing is reported as settled, posted or completed.
    const b = await batchRow(t, batchId);
    expect(b.paymentStatus).toBe("successful");
    expect(b.allocationStatus).toBe("allocated");
    const settlements = await t.run((ctx) =>
      ctx.db.query("settlements").withIndex("by_batch", (q) => q.eq("batchId", batchId)).collect(),
    );
    expect(settlements.length).toBe(3);
    expect(settlements.every((s) => s.status === "pending")).toBe(true);
    expect(b.status).toBe("processing");
    expect(b.pfaStatus).not.toBe("posted");
    expect(b.reconciliationStatus).not.toBe("reconciled");
    const acks = await t.run((ctx) => ctx.db.query("pfaAcknowledgements").collect());
    expect(acks).toHaveLength(0);
  });

  test("webhook: amount mismatch is never finalized", async () => {
    const { batchId, ref, amount } = await initiated();
    const res = await postWebhook(t, {
      event: "charge.success",
      data: { reference: ref, amount: amount - 100, currency: "NGN", status: "success" },
    });
    expect(res.status).toBe(200);
    expect((await paymentsFor(t, batchId))[0].status).toBe("failed");
    expect((await ledgerTotals(t, batchId)).rows).toBe(0);
  });

  test("retry after a failed payment uses a NEW payment and finalizes that one only", async () => {
    const { emp, batchId, ref: firstRef, amount } = await initiated();
    await postWebhook(t, { event: "charge.failed", data: { reference: firstRef } });
    expect((await paymentsFor(t, batchId))[0].status).toBe("failed");

    const retry = await emp.client.mutation(api.engine.payBatch, { batchId });
    if (!("requiresCheckout" in retry)) throw new Error("expected checkout handoff");
    expect(retry.paymentRef).not.toBe(firstRef);
    const ctxInfo = await emp.client.query(api.engine.getLivePaymentContext, { batchId });
    expect(ctxInfo?.paymentRef).toBe(retry.paymentRef);

    await postWebhook(t, {
      event: "charge.success",
      data: { reference: retry.paymentRef, amount, currency: "NGN", status: "success" },
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const pays = await paymentsFor(t, batchId);
    const byRef = new Map(pays.map((p) => [p.paymentRef, p.status]));
    expect(byRef.get(firstRef)).toBe("failed");
    expect(byRef.get(retry.paymentRef)).toBe("successful");
    const ledger = await ledgerTotals(t, batchId);
    expect(ledger.debit).toBe(ledger.credit);
  });

  test("manual settlement confirmation: own PFA only, then reconciliation completes the batch", async () => {
    const { batchId, ref, amount } = await initiated();
    await postWebhook(t, {
      event: "charge.success",
      data: { reference: ref, amount, currency: "NGN", status: "success" },
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const settlements = await t.run((ctx) =>
      ctx.db.query("settlements").withIndex("by_batch", (q) => q.eq("batchId", batchId)).collect(),
    );

    // A PFA operator cannot confirm another PFA's settlement.
    const [s0, ...rest] = settlements;
    const other = settlements.find((s) => s.pfaId !== s0.pfaId)!;
    const wrongOp = await signedInAs(t, { email: "ops@other-pfa.test", role: "pfa", pfaId: other.pfaId });
    await expect(
      wrongOp.client.mutation(api.settlementOps.confirmSettlement, {
        settlementId: s0._id,
        reference: "PFA-POST-001",
      }),
    ).rejects.toThrow(/not authorized/i);
    // An employer cannot confirm settlements at all.
    const stranger = await signedInAs(t, { email: "x@x.test" });
    await expect(
      stranger.client.mutation(api.settlementOps.confirmSettlement, { settlementId: s0._id, reference: "X-1" }),
    ).rejects.toThrow();

    const ownOp = await signedInAs(t, { email: "ops@pfa0.test", role: "pfa", pfaId: s0.pfaId });
    await ownOp.client.mutation(api.settlementOps.confirmSettlement, {
      settlementId: s0._id,
      reference: "PFA-POST-001",
    });
    const admin = await ensureAdmin(t);
    for (const s of rest) {
      await admin.client.mutation(api.settlementOps.confirmSettlement, {
        settlementId: s._id,
        reference: `PFA-POST-${s.settlementRef}`,
      });
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const b = await batchRow(t, batchId);
    expect(b.settlementStatus).toBe("settled");
    expect(b.reconciliationStatus).toBe("reconciled");
    expect(b.status).toBe("completed");
    const recs = await t.run((ctx) =>
      ctx.db.query("contributionRecords").withIndex("by_batch", (q) => q.eq("batchId", batchId)).collect(),
    );
    expect(recs.every((r) => r.settlementStatus === "settled" && r.pfaStatus === "posted")).toBe(true);
    // Confirming twice is rejected (idempotent, no double-posting).
    await expect(
      admin.client.mutation(api.settlementOps.confirmSettlement, { settlementId: s0._id, reference: "AGAIN" }),
    ).rejects.toThrow(/already/i);
  });
});

describe("sandbox environment (explicitly enabled)", () => {
  beforeEach(() => {
    vi.stubEnv("PENROUTE_SANDBOX_MODE", "enabled");
  });

  test("end-to-end sandbox journey completes, reconciles and keeps the ledger balanced", async () => {
    const emp = await approvedEmployer(t, "fin@sbx.test", "RC-3001");
    const records = schedule(9);
    const { batchId, duplicate } = await emp.client.mutation(api.engine.prepareBatch, {
      year: 2026,
      month: 8,
      records,
    });
    expect(duplicate).toBe(false);
    const again = await emp.client.mutation(api.engine.prepareBatch, { year: 2026, month: 8, records });
    expect(again.duplicate).toBe(true);
    expect(again.batchId).toBe(batchId);

    const pay = await emp.client.mutation(api.engine.payBatch, { batchId });
    expect("alreadyPaid" in pay && pay.alreadyPaid).toBe(false);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const b = await batchRow(t, batchId);
    expect(b.status).toBe("completed");
    expect(b.reconciliationStatus).toBe("reconciled");
    const ledger = await ledgerTotals(t, batchId);
    expect(ledger.debit).toBe(ledger.credit);
    // The payment is visibly a sandbox transfer.
    expect((await paymentsFor(t, batchId))[0].rail).toBe("sandbox_transfer");
    // Paying again is idempotent.
    const second = await emp.client.mutation(api.engine.payBatch, { batchId }).catch((e: Error) => e);
    expect(second instanceof Error ? second.message : "").toMatch(/not payable/);
    expect((await paymentsFor(t, batchId)).length).toBe(1);
  });
});

void internal;
