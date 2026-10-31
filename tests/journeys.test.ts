import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/convex/_generated/api";
import {
  acceptCac,
  ensureAdmin,
  hmacSha512Hex,
  newBackend,
  resetAdminCache,
  seedPfas,
  signedInAs,
  type Backend,
} from "./helpers";

const KEY = "sk_test_penroute_journey_suite_000000000000";
let t: Backend;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubEnv("PAYSTACK_SECRET_KEY", KEY);
  resetAdminCache();
  t = newBackend();
  await seedPfas(t);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("production journey: employer → Paystack → PFA → reconciliation → reports", () => {
  test("full lifecycle with real role separation and database-backed reports", async () => {
    const admin = await ensureAdmin(t);
    await admin.client.mutation(api.admin.adminSetRailMode, { mode: "live" });

    // 1. Employer registers (pending) and builds a roster.
    const owner = await signedInAs(t, { email: "payroll@zenith-foods.test" });
    const { employerId } = await owner.client.mutation(api.pension.registerEmployer, {
      name: "Zenith Foods Ltd",
      rcNumber: "RC-778899",
      tin: "TIN-778899-0001",
      registeredAddress: "12 Allen Avenue, Ikeja",
      contactEmail: "payroll@zenith-foods.test",
      contactPhone: "+2348011112222",
      representativeName: "Bola Ade",
      acceptTerms: true,
    });
    const pfas = await owner.client.query(api.pension.listPfas, {});
    expect(pfas.length).toBeGreaterThanOrEqual(19);
    expect(pfas.every((p) => !("endpointConfig" in p))).toBe(true);
    const [pA, pB] = pfas.filter((p) => p.active);
    const staff = [
      { fullName: "Ngozi Eze", employeeCode: "ZF-001", pensionPin: "PEN200001", pfaId: pA._id },
      { fullName: "Musa Bello", employeeCode: "ZF-002", pensionPin: "PEN200002", pfaId: pA._id },
      { fullName: "Tolu Ojo", employeeCode: "ZF-003", pensionPin: "PEN200003", pfaId: pB._id },
    ];
    for (const s of staff) await owner.client.mutation(api.pension.addEmployee, s);
    await expect(owner.client.mutation(api.pension.addEmployee, staff[0])).rejects.toThrow(/already exists/);
    const roster = await owner.client.query(api.pension.listEmployerEmployees, {});
    expect(roster).toHaveLength(3);

    // Pending employers cannot pay.
    await expect(
      owner.client.mutation(api.engine.prepareBatch, { year: 2026, month: 10, records: [] }),
    ).rejects.toThrow(/approved/);

    // 2. Admin reviews KYB details and approves.
    const list = await admin.client.query(api.admin.listAllEmployers, {});
    const row = list.find((e) => e._id === employerId)!;
    expect(row.tin).toBe("TIN-778899-0001");
    expect(row.status).toBe("pending");
    // Approval is refused until the CAC certificate is uploaded and accepted.
    await expect(
      admin.client.mutation(api.admin.adminSetEmployerStatus, { employerId, status: "active" }),
    ).rejects.toThrow(/CAC certificate/);
    await acceptCac(t, owner.client, admin.client);
    await admin.client.mutation(api.admin.adminSetEmployerStatus, { employerId, status: "active" });

    // 3. Monthly schedule → quote → Paystack checkout handoff.
    const records = staff.map((s, i) => ({
      fullName: s.fullName,
      employeeCode: s.employeeCode,
      pensionPin: s.pensionPin,
      pfaCode: (i < 2 ? pA : pB).code,
      employeeContribution: 8000,
      employerContribution: 10000,
    }));
    const { batchId } = await owner.client.mutation(api.engine.prepareBatch, { year: 2026, month: 10, records });
    const draft = await owner.client.query(api.engine.getDraftSummary, { year: 2026, month: 10 });
    expect(draft?.validCount).toBe(3);
    expect(draft?.pension).toBe(3 * 18000 * 100);
    const pay = await owner.client.mutation(api.engine.payBatch, { batchId });
    if (!("requiresCheckout" in pay)) throw new Error("expected Paystack checkout");
    expect(pay.amountKobo).toBe(draft!.totalDebit);

    // 4. Paystack confirms by signed webhook.
    const body = JSON.stringify({
      event: "charge.success",
      data: { reference: pay.paymentRef, amount: pay.amountKobo, currency: "NGN", status: "success" },
    });
    const res = await t.fetch("/webhooks/paystack", {
      method: "POST",
      headers: { "x-paystack-signature": await hmacSha512Hex(KEY, body) },
      body,
    });
    expect(res.status).toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    let detail = await owner.client.query(api.pension.getBatchDetail, { batchId });
    expect(detail?.payment?.status).toBe("successful");
    expect(detail?.batch.status).toBe("processing");
    expect(detail?.settlements.map((s) => s.status).sort()).toEqual(["pending", "pending"]);

    // Billing: revenue is recognised only after confirmed payment.
    const billing = await owner.client.query(api.billing.getEmployerBilling, {});
    expect(JSON.stringify(billing)).toContain(pay.paymentRef);

    // 5. Admin provisions a PFA operator; they claim access on first sign-in.
    await admin.client.mutation(api.pfaPortal.adminProvisionAccess, { email: "ops@pfa-a.test", pfaId: pA._id });
    const op = await signedInAs(t, { email: "ops@pfa-a.test" });
    expect((await op.client.mutation(api.pfaPortal.claimAccess, {})).claimed).toBe(true);
    const session = await op.client.query(api.pfaPortal.getSession, {});
    expect(session?.pfa._id).toBe(pA._id);
    const awaiting = await op.client.query(api.settlementOps.listAwaitingConfirmation, {});
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0].employeeCount).toBe(2);
    // The operator only sees their PFA's contributions.
    const contribs = await op.client.query(api.pfaPortal.listContributions, {});
    expect(JSON.stringify(contribs)).not.toContain("Tolu Ojo");

    await op.client.mutation(api.settlementOps.confirmSettlement, {
      settlementId: awaiting[0]._id,
      reference: "PFA-A-POST-0001",
    });
    const rest = await admin.client.query(api.settlementOps.listAwaitingConfirmation, {});
    expect(rest).toHaveLength(1);
    await admin.client.mutation(api.settlementOps.confirmSettlement, {
      settlementId: rest[0]._id,
      reference: "PFA-B-REMIT-77",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // 6. Reconciled & completed — every figure agrees.
    detail = await owner.client.query(api.pension.getBatchDetail, { batchId });
    expect(detail?.batch.status).toBe("completed");
    expect(detail?.batch.reconciliationStatus).toBe("reconciled");
    expect(detail?.pfaAcks.every((a) => a.status === "posted")).toBe(true);
    const ledger = await owner.client.query(api.pension.listEmployerLedger, {});
    const debit = ledger.reduce((s: number, r: { debit: number }) => s + r.debit, 0);
    const credit = ledger.reduce((s: number, r: { credit: number }) => s + r.credit, 0);
    expect(debit).toBe(credit);

    // 7. Dashboard, history and audit trail come from the database.
    const dash = await owner.client.query(api.pension.getEmployerDashboard, {});
    expect(dash?.stats.completed).toBe(1);
    expect(dash?.totalProcessed).toBe(3 * 18000 * 100);
    const history = await owner.client.query(api.contributions.getContributionHistory, {});
    expect(history.batches).toHaveLength(1);
    const auditRows = await owner.client.query(api.pension.listEmployerAudit, {});
    const actions = auditRows.map((a: { action: string }) => a.action);
    for (const a of ["employer_registered", "employee_added", "prepare_batch", "payment_initiated", "payment_successful", "settlement_confirmed", "batch_completed"]) {
      expect(actions).toContain(a);
    }
    const adminOverview = await admin.client.query(api.admin.getAdminOverview, {});
    expect(adminOverview.railMode).toBe("live");
    expect(adminOverview.batchesCount).toBe(1);

    // 8. Access revocation: unlinking the operator closes the portal.
    const access = await admin.client.query(api.pfaPortal.adminListAccess, {});
    expect(JSON.stringify(access)).toContain("ops@pfa-a.test");
    await admin.client.mutation(api.pfaPortal.adminUnlinkPfaUser, { userId: op.userId });
    await expect(op.client.query(api.pfaPortal.getOverview, {})).rejects.toThrow(/PFA portal access/);
  });

  test("exceptions: employers resolve only their own; suspension blocks new payments", async () => {
    const admin = await ensureAdmin(t);
    await admin.client.mutation(api.admin.adminSetRailMode, { mode: "live" });
    const mk = async (email: string, rc: string) => {
      const u = await signedInAs(t, { email });
      const { employerId } = await u.client.mutation(api.pension.registerEmployer, {
        name: rc, rcNumber: rc, tin: "T", registeredAddress: "A", contactEmail: email, contactPhone: "1", representativeName: "R", acceptTerms: true,
      });
      await acceptCac(t, u.client, admin.client);
      await admin.client.mutation(api.admin.adminSetEmployerStatus, { employerId, status: "active" });
      return { ...u, employerId };
    };
    const a = await mk("a@a.test", "RC-X1");
    const b = await mk("b@b.test", "RC-X2");
    const { batchId } = await a.client.mutation(api.engine.prepareBatch, {
      year: 2026, month: 1,
      records: [{ fullName: "A", employeeCode: "1", pensionPin: "PEN300001", pfaCode: "101", employeeContribution: 10, employerContribution: 10 }],
    });
    const pay = await a.client.mutation(api.engine.payBatch, { batchId });
    if (!("requiresCheckout" in pay)) throw new Error("expected checkout");
    const body = JSON.stringify({ event: "charge.failed", data: { reference: pay.paymentRef } });
    await t.fetch("/webhooks/paystack", { method: "POST", headers: { "x-paystack-signature": await hmacSha512Hex(KEY, body) }, body });
    const [exc] = await a.client.query(api.pension.listEmployerExceptions, {});
    expect(exc.type).toBe("payment_mismatch");
    await expect(b.client.mutation(api.pension.resolveException, { exceptionId: exc._id, notes: "x" })).rejects.toThrow(
      /not authorized/i,
    );
    await a.client.mutation(api.pension.resolveException, { exceptionId: exc._id, notes: "Card declined — retried" });

    await admin.client.mutation(api.admin.adminSetEmployerStatus, { employerId: a.employerId, status: "suspended" });
    await expect(a.client.mutation(api.engine.payBatch, { batchId })).rejects.toThrow(/approved/);
  });
});
