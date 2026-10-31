import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../src/convex/_generated/api";
import {
  prePaymentChecks,
  remittanceDeadline,
  salaryDate,
  statutoryContribution,
  daysUntil,
} from "../src/lib/compliance";
import { approvedEmployer, newBackend, resetAdminCache, schedule, seedPfas, type Backend } from "./helpers";

describe("statutory engine (pure)", () => {
  test("8% employee / 10% employer of monthly emoluments, kobo-exact", () => {
    expect(statutoryContribution(350_000_00)).toEqual({ employeeKobo: 28_000_00, employerKobo: 35_000_00 });
    expect(statutoryContribution(0)).toEqual({ employeeKobo: 0, employerKobo: 0 });
    expect(statutoryContribution(Number.NaN)).toEqual({ employeeKobo: 0, employerKobo: 0 });
  });

  test("deadline = 7 working days after salary, skipping weekends", () => {
    // Fri 25 Sep 2026 → Mon 28 … Tue 6 Oct 2026 (7 working days).
    expect(salaryDate(2026, 9, 25)).toBe("2026-09-25");
    expect(remittanceDeadline(2026, 9, 25)).toBe("2026-10-06");
    // Pay day beyond month end clamps to the last day (Feb).
    expect(salaryDate(2026, 2, 31)).toBe("2026-02-28");
    // December rolls into January.
    expect(remittanceDeadline(2026, 12, 28)).toBe("2027-01-06");
    expect(daysUntil("2026-10-06", "2026-10-01")).toBe(5);
    expect(daysUntil("2026-10-06", "2026-10-08")).toBe(-2);
  });

  test("pre-payment checks: zero rows block; below-minimum, PFA change, swings and leavers warn", () => {
    const rows = [
      { key: "a", fullName: "A", pensionPin: "P1", pfaCode: "101", employeeKobo: 0, employerKobo: 0 },
      { key: "b", fullName: "B", pensionPin: "P2", pfaCode: "102", employeeKobo: 10_000_00, employerKobo: 10_000_00, emolumentKobo: 300_000_00 },
      { key: "c", fullName: "C", pensionPin: "P3", pfaCode: "101", employeeKobo: 24_000_00, employerKobo: 30_000_00, emolumentKobo: 300_000_00 },
      { key: "d", fullName: "D", pensionPin: "P4", pfaCode: "101", employeeKobo: 1_000_00, employerKobo: 1_000_00 },
    ];
    const prev = [
      { pensionPin: "P2", pfaCode: "101", employeeKobo: 10_000_00, employerKobo: 10_000_00 },
      { pensionPin: "P3", pfaCode: "101", employeeKobo: 10_000_00, employerKobo: 10_000_00 },
      { pensionPin: "P9", pfaCode: "101", employeeKobo: 5_000_00, employerKobo: 5_000_00 },
    ];
    const f = prePaymentChecks(rows, prev);
    const msgs = f.map((x) => `${x.level}:${x.message}`).join("\n");
    expect(f.filter((x) => x.level === "block")).toHaveLength(1);
    expect(msgs).toMatch(/warn:B .*employer share is below the 10%/);
    expect(msgs).toMatch(/warn:B .*employee share is below the 8%/);
    expect(msgs).toMatch(/warn:B .*PFA changed/);
    expect(msgs).toMatch(/warn:C .*up 170%/);
    expect(msgs).toMatch(/info:D .*not in last month/);
    expect(msgs).toMatch(/warn:1 employee\(s\) paid last month are missing.*P9/);
    expect(prePaymentChecks(rows.slice(2, 3), null).filter((x) => x.level !== "info")).toHaveLength(0);
  });
});

describe("compliance backend", () => {
  let t: Backend;
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T09:00:00Z"));
    vi.stubEnv("PENROUTE_SANDBOX_MODE", "enabled");
    resetAdminCache();
    t = newBackend();
    await seedPfas(t);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test("record, reminders, emoluments and previous-month baseline", async () => {
    const emp = await approvedEmployer(t, "fin@deadline.test", "RC-DL");
    await emp.client.mutation(api.compliance.setSalaryPayDay, { day: 25 });
    await expect(emp.client.mutation(api.compliance.setSalaryPayDay, { day: 40 })).rejects.toThrow();

    // Emoluments are stored in kobo and returned to the wizard.
    const pfa = await t.run(async (ctx) => (await ctx.db.query("pfas").first())!);
    await emp.client.mutation(api.pension.addEmployee, {
      fullName: "Ada",
      employeeCode: "E1",
      pensionPin: "PEN555001",
      pfaId: pfa._id,
      monthlyEmolument: 350000,
    });
    const ready = await emp.client.query(api.contributions.getReadyEmployees, { year: 2026, month: 9 });
    expect(ready.employees[0].monthlyEmolumentKobo).toBe(35_000_000);

    // Pay September on time (sandbox deployment) — 3 Oct is before the 6 Oct deadline.
    vi.setSystemTime(new Date("2026-10-03T09:00:00Z"));
    const { batchId } = await emp.client.mutation(api.engine.prepareBatch, { year: 2026, month: 9, records: schedule(3) });
    await emp.client.mutation(api.engine.payBatch, { batchId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const prev = await emp.client.query(api.compliance.getPreviousSchedule, { year: 2026, month: 10 });
    expect(prev?.period).toBe("2026-09");
    expect(prev?.rows).toHaveLength(3);

    // October is unpaid: 3 days before its deadline (Tue 3 Nov 2026) a reminder goes out, once.
    vi.setSystemTime(new Date("2026-10-31T09:00:00Z"));
    const r1 = await t.mutation(internal.compliance.remindDeadlines, {});
    const r2 = await t.mutation(internal.compliance.remindDeadlines, {});
    expect(r1.sent).toBe(1);
    expect(r2.sent).toBe(0);
    vi.setSystemTime(new Date("2026-11-05T09:00:00Z"));
    expect((await t.mutation(internal.compliance.remindDeadlines, {})).sent).toBe(1);
    const inbox = await emp.client.query(api.notifications.listMine, {});
    expect(inbox.map((n) => n.kind)).toEqual(expect.arrayContaining(["deadline_soon", "deadline_overdue"]));

    const rec = await emp.client.query(api.compliance.getComplianceRecord, {});
    const sep = rec!.rows.find((r) => r.period === "2026-09")!;
    const oct = rec!.rows.find((r) => r.period === "2026-10")!;
    expect(sep.status).toBe("on_time");
    expect(sep.posted).toBe(true);
    expect(oct.status).toBe("overdue");
    expect(oct.deadline).toBe("2026-11-03");
    expect(rec!.current?.period).toBe("2026-10");
    expect(rec!.summary.onTimeRate).toBe(100);
  });
});
