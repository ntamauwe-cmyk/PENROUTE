import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../src/convex/_generated/api";
import { friendlyError } from "../src/lib/errors";
import { approvedEmployer, newBackend, resetAdminCache, seedPfas, type Backend } from "./helpers";

let t: Backend;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubEnv("PENROUTE_SANDBOX_MODE", "enabled");
  resetAdminCache();
  t = newBackend();
  await seedPfas(t);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("employee self-service contribution check", () => {
  async function setup() {
    const emp = await approvedEmployer(t, "hr@check.test", "RC-CHK");
    const pfa = await t.run(async (ctx) => (await ctx.db.query("pfas").first())!);
    await emp.client.mutation(api.pension.addEmployee, {
      fullName: "Ngozi Adaeze Okafor",
      employeeCode: "ZF-007",
      pensionPin: "PEN777000111",
      pfaId: pfa._id,
    });
    await emp.client.mutation(api.pension.addEmployee, {
      fullName: "Musa Bello",
      employeeCode: "ZF-008",
      pensionPin: "PEN777000222",
      pfaId: pfa._id,
    });
    const rows = [
      { fullName: "Ngozi Adaeze Okafor", employeeCode: "ZF-007", pensionPin: "PEN777000111", pfaCode: pfa.code, employeeContribution: 24000, employerContribution: 30000 },
      { fullName: "Musa Bello", employeeCode: "ZF-008", pensionPin: "PEN777000222", pfaCode: pfa.code, employeeContribution: 16000, employerContribution: 20000 },
    ];
    const { batchId } = await emp.client.mutation(api.engine.prepareBatch, { year: 2026, month: 9, records: rows });
    await emp.client.mutation(api.engine.payBatch, { batchId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await emp.client.mutation(api.engine.prepareBatch, { year: 2026, month: 10, records: rows });
  }

  test("an employee sees only their own months, with paid/posted status", async () => {
    await setup();
    const res = await t.mutation(api.employeeCheck.checkMyContributions, {
      pensionPin: "pen 777000111",
      employeeCode: "zf-007",
      surname: "okafor",
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.firstName).toBe("Ngozi");
    expect(res.lines.map((l) => `${l.period}:${l.status}`)).toEqual(["2026-10:not_paid", "2026-09:posted"]);
    expect(res.lines[1].employeeKobo).toBe(2_400_000);
    expect(JSON.stringify(res)).not.toContain("Musa");
  });

  test("wrong details fail with one generic message; PIN locks after 5 failures", async () => {
    await setup();
    const bad = { pensionPin: "PEN777000111", employeeCode: "ZF-007", surname: "Bello" };
    for (let i = 0; i < 5; i++) {
      const r = await t.mutation(api.employeeCheck.checkMyContributions, bad);
      expect(r.ok ? "" : r.error).toMatch(/couldn't match/);
    }
    // Even correct details are refused while locked.
    const locked = await t.mutation(api.employeeCheck.checkMyContributions, { ...bad, surname: "Okafor" });
    expect(locked.ok ? "" : locked.error).toMatch(/Too many attempts/);
    // The lock lifts after an hour.
    vi.advanceTimersByTime(61 * 60 * 1000);
    const ok = await t.mutation(api.employeeCheck.checkMyContributions, { ...bad, surname: "Okafor" });
    expect(ok.ok && ok.lines.length).toBe(2);
    // The throttle stores a hash, never the PIN.
    const rows = await t.run((ctx) => ctx.db.query("employeeLookups").collect());
    expect(JSON.stringify(rows)).not.toContain("PEN777000111");
  });
});

describe("user-facing errors survive production redaction", () => {
  test("backend throws ConvexError, and the UI helper shows its message", async () => {
    const err = await t
      .mutation(api.engine.prepareBatch, { year: 2026, month: 1, records: [] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConvexError);
    expect(friendlyError(err)).toBe("Not authenticated");
    expect(friendlyError(new Error("[CONVEX M(x)] [Request ID: abc] Server Error\nUncaught Error: Batch not found\n    at handler"))).toBe("Batch not found");
    expect(friendlyError(new Error("[CONVEX M(x)] [Request ID: abc] Server Error"))).toMatch(/Something went wrong/);
  });
});
