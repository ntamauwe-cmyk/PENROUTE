import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/convex/_generated/api";
import { approvedEmployer, newBackend, resetAdminCache, schedule, seedPfas, type Backend } from "./helpers";

let t: Backend;
beforeEach(async () => {
  resetAdminCache();
  t = newBackend();
  await seedPfas(t);
});
afterEach(() => vi.unstubAllEnvs());

describe("schedule validation", () => {
  test("record totals are exactly employee + employer kobo (no rounding drift)", async () => {
    const emp = await approvedEmployer(t, "f@f.test", "RC-F");
    const rows = [
      { fullName: "A", employeeCode: "1", pensionPin: "PEN111111", pfaCode: "101", employeeContribution: 0.005, employerContribution: 0.005 },
      { fullName: "B", employeeCode: "2", pensionPin: "PEN222222", pfaCode: "101", employeeContribution: 1234.565, employerContribution: 99.995 },
    ];
    const { batchId } = await emp.client.mutation(api.engine.prepareBatch, { year: 2026, month: 2, records: rows });
    const recs = await t.run((ctx) =>
      ctx.db.query("contributionRecords").withIndex("by_batch", (q) => q.eq("batchId", batchId)).collect(),
    );
    for (const r of recs) expect(r.totalAmount).toBe(r.employeeContribution + r.employerContribution);
  });

  test("non-finite, negative, unknown-PFA, bad-PIN and duplicate-PIN rows are flagged, never paid", async () => {
    const emp = await approvedEmployer(t, "g@g.test", "RC-G");
    const base = { fullName: "X", employeeCode: "E", pfaCode: "101", employerContribution: 10 };
    const rows = [
      { ...base, pensionPin: "PEN000001", employeeContribution: Number.POSITIVE_INFINITY },
      { ...base, pensionPin: "PEN000002", employeeContribution: -5 },
      { ...base, pensionPin: "PEN000003", employeeContribution: 5, pfaCode: "999" },
      { ...base, pensionPin: "!!", employeeContribution: 5 },
      { ...base, pensionPin: "PEN000005", employeeContribution: 5 },
      { ...base, pensionPin: "PEN000005", employeeContribution: 6 },
      { ...base, pensionPin: "PEN000007", employeeContribution: 7 },
    ];
    const { batchId } = await emp.client.mutation(api.engine.prepareBatch, { year: 2026, month: 4, records: rows });
    const recs = await t.run((ctx) =>
      ctx.db.query("contributionRecords").withIndex("by_batch", (q) => q.eq("batchId", batchId)).collect(),
    );
    const valid = recs.filter((r) => r.validationStatus === "valid");
    expect(valid.map((r) => r.pensionPin)).toEqual(["PEN000007"]);
    for (const r of recs) expect(Number.isFinite(r.totalAmount)).toBe(true);
  });

  test("invalid period values are rejected", async () => {
    const emp = await approvedEmployer(t, "h@h.test", "RC-H");
    await expect(
      emp.client.mutation(api.engine.prepareBatch, { year: 2026, month: 13, records: schedule(1) }),
    ).rejects.toThrow(/month/i);
    await expect(
      emp.client.mutation(api.engine.prepareBatch, { year: 1850, month: 1, records: schedule(1) }),
    ).rejects.toThrow(/year/i);
  });

  test("identical schedules from two employers never collide on idempotency", async () => {
    const a = await approvedEmployer(t, "a@a.test", "RC-AA");
    const b = await approvedEmployer(t, "b@b.test", "RC-BB");
    const rows = schedule(4);
    const ra = await a.client.mutation(api.engine.prepareBatch, { year: 2026, month: 5, records: rows });
    const rb = await b.client.mutation(api.engine.prepareBatch, { year: 2026, month: 5, records: rows });
    expect(ra.duplicate).toBe(false);
    expect(rb.duplicate).toBe(false);
    expect(ra.batchId).not.toBe(rb.batchId);
    const fp = await t.run(async (ctx) => (await ctx.db.get(ra.batchId))!.fingerprint);
    expect(fp).toMatch(/^fp_[0-9a-f]{64}$/);
  });
});

describe("payroll/HR API (POST /api/v1/schedules)", () => {
  test("rejects missing/invalid keys and accepts a valid key", async () => {
    const emp = await approvedEmployer(t, "p@p.test", "RC-P");
    const body = JSON.stringify({ contributionYear: 2026, contributionMonth: 6, records: schedule(3) });
    const none = await t.fetch("/api/v1/schedules", { method: "POST", body });
    expect(none.status).toBe(401);
    const bad = await t.fetch("/api/v1/schedules", {
      method: "POST",
      headers: { authorization: "Bearer penr_live_deadbeef" },
      body,
    });
    expect(bad.status).toBe(401);

    const { apiKey } = await emp.client.mutation(api.employers.generateApiKey, {});
    const ok = await t.fetch("/api/v1/schedules", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body,
    });
    expect(ok.status).toBe(200);
    const json = (await ok.json()) as { ok: boolean; batchRef: string; validCount: number };
    expect(json.ok).toBe(true);
    expect(json.validCount).toBe(3);
    // Revoked keys stop working immediately.
    await emp.client.mutation(api.employers.revokeApiKey, {});
    const after = await t.fetch("/api/v1/schedules", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ contributionYear: 2026, contributionMonth: 7, records: schedule(3) }),
    });
    expect(after.status).toBe(401);
  });
});
