import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { getCurrentUser } from "./users";
import { audit, getCurrentEmployer, getEmployerForUser } from "./employers";
import { notify } from "./notifications";
import {
  DEFAULT_SALARY_PAY_DAY,
  daysUntil,
  lagosToday,
  remittanceDeadline,
  salaryDate,
} from "../lib/compliance";

// ============================================================================
// COMPLIANCE — remittance deadlines (PRA 2014: 7 working days after salary),
// a month-by-month compliance record (evidence for a PenCom compliance
// certificate application), last month's baseline for pre-payment checks,
// and automatic deadline reminders.
// ============================================================================

const PAID = new Set(["successful"]);

function periodKey(y: number, m: number) {
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** Months from the employer's first month on Penroute up to last month (max 24). */
function monthsToTrack(createdAt: number, today: string): { year: number; month: number }[] {
  const [ty, tm] = today.split("-").map(Number);
  const start = new Date(createdAt + 60 * 60 * 1000);
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth() + 1;
  const out: { year: number; month: number }[] = [];
  // Contributions for month M fall due in month M (salary) / M+1 (deadline).
  while ((y < ty || (y === ty && m <= tm)) && out.length < 240) {
    out.push({ year: y, month: m });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out.slice(-24);
}

async function employerBatches(ctx: QueryCtx, employer: Doc<"employers">) {
  return ctx.db
    .query("contributionBatches")
    .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
    .order("desc")
    .take(300);
}

function rowFor(
  employer: Doc<"employers">,
  batches: Doc<"contributionBatches">[],
  year: number,
  month: number,
  today: string,
) {
  const payDay = employer.salaryPayDay ?? DEFAULT_SALARY_PAY_DAY;
  const due = remittanceDeadline(year, month, payDay);
  const batch = batches.find(
    (b) => b.contributionYear === year && b.contributionMonth === month && b.status !== "failed",
  );
  const paid = batch && PAID.has(batch.paymentStatus) && batch.paymentDate;
  const paidOn = paid ? new Date(batch.paymentDate! + 60 * 60 * 1000).toISOString().slice(0, 10) : null;
  let status: "on_time" | "late" | "overdue" | "due" | "not_due";
  if (paidOn) status = paidOn <= due ? "on_time" : "late";
  else if (today > due) status = "overdue";
  else if (today >= salaryDate(year, month, payDay)) status = "due";
  else status = "not_due";
  return {
    period: periodKey(year, month),
    year,
    month,
    salaryDate: salaryDate(year, month, payDay),
    deadline: due,
    daysLeft: daysUntil(due, today),
    status,
    paidOn,
    batchRef: batch?.batchRef ?? null,
    batchStatus: batch?.status ?? null,
    posted: batch?.status === "completed",
    pensionKobo: batch?.totalPensionAmount ?? 0,
    employees: batch?.employeeCount ?? 0,
  };
}

/** The current remittance obligation + the month-by-month compliance record. */
export const getComplianceRecord = query({
  args: {},
  handler: async (ctx) => {
    const employer = await getCurrentEmployer(ctx);
    if (!employer) return null;
    const today = lagosToday();
    const batches = await employerBatches(ctx, employer);
    const months = monthsToTrack(employer.createdAt, today);
    const rows = months.map((p) => rowFor(employer, batches, p.year, p.month, today)).reverse();
    const settled = rows.filter((r) => r.status === "on_time" || r.status === "late");
    // The obligation to act on: the oldest unpaid month that is due/overdue,
    // else the next upcoming one.
    const open = [...rows].reverse().find((r) => r.status === "overdue" || r.status === "due");
    const upcoming = rows.find((r) => r.status === "not_due");
    return {
      salaryPayDay: employer.salaryPayDay ?? null,
      assumedPayDay: employer.salaryPayDay ? null : DEFAULT_SALARY_PAY_DAY,
      today,
      current: open ?? upcoming ?? null,
      rows,
      summary: {
        months: settled.length,
        onTime: settled.filter((r) => r.status === "on_time").length,
        late: settled.filter((r) => r.status === "late").length,
        overdue: rows.filter((r) => r.status === "overdue").length,
        onTimeRate: settled.length ? Math.round((settled.filter((r) => r.status === "on_time").length / settled.length) * 100) : null,
      },
    };
  },
});

/** Last PAID month's per-employee amounts before (year, month) — the baseline
 *  for pre-payment anomaly checks. */
export const getPreviousSchedule = query({
  args: { year: v.number(), month: v.number() },
  handler: async (ctx, { year, month }) => {
    const employer = await getCurrentEmployer(ctx);
    if (!employer) return null;
    const batches = await employerBatches(ctx, employer);
    const target = year * 12 + month;
    const prev = batches
      .filter(
        (b) =>
          b.paymentStatus === "successful" && b.contributionYear * 12 + b.contributionMonth < target,
      )
      .sort((a, b) => b.contributionYear * 12 + b.contributionMonth - (a.contributionYear * 12 + a.contributionMonth))[0];
    if (!prev) return null;
    const records = await ctx.db
      .query("contributionRecords")
      .withIndex("by_batch", (q) => q.eq("batchId", prev._id))
      .take(10_000);
    const pfaIds = [...new Set(records.map((r) => r.pfaId))];
    const pfas = await Promise.all(pfaIds.map((id) => ctx.db.get(id)));
    const codeById = new Map(pfas.flatMap((p) => (p ? [[p._id, p.code] as const] : [])));
    return {
      period: periodKey(prev.contributionYear, prev.contributionMonth),
      rows: records
        .filter((r) => r.validationStatus === "valid")
        .map((r) => ({
          pensionPin: r.pensionPin,
          pfaCode: codeById.get(r.pfaId) ?? "",
          employeeKobo: r.employeeContribution,
          employerKobo: r.employerContribution,
        })),
    };
  },
});

export const setSalaryPayDay = mutation({
  args: { day: v.number() },
  handler: async (ctx, { day }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const employer = await getEmployerForUser(ctx, user);
    if (!employer) throw new Error("No employer profile");
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("Pay day must be between 1 and 31");
    await ctx.db.patch(employer._id, { salaryPayDay: day });
    await audit(ctx, {
      actor: user.email ?? "unknown",
      action: "salary_pay_day_set",
      entityType: "employer",
      entityId: employer._id,
      employerId: employer._id,
      field: "salaryPayDay",
      before: String(employer.salaryPayDay ?? "(default)"),
      after: String(day),
    });
    return { ok: true };
  },
});

/** Daily (cron): remind approved employers 3 days before the deadline, on the
 *  day, and once when overdue. Idempotent per period + reminder kind. */
export const remindDeadlines = internalMutation({
  args: {},
  handler: async (ctx) => {
    const today = lagosToday();
    const employers = await ctx.db
      .query("employers")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .take(2_000);
    let sent = 0;
    for (const e of employers) {
      const batches = await employerBatches(ctx, e);
      const [ty, tm] = today.split("-").map(Number);
      // Deadlines for month M fall early in M+1: check this month and the two
      // before, oldest first, so an overdue month is reminded ahead of a new one.
      for (const back of [2, 1, 0]) {
        let y = ty;
        let m = tm - back;
        while (m < 1) {
          m += 12;
          y--;
        }
        if (Date.UTC(y, m, 0) < e.createdAt) continue; // before they joined
        const row = rowFor(e, batches, y, m, today);
        if (row.status === "on_time" || row.status === "late") continue;
        const kind = row.daysLeft < 0 ? "overdue" : row.daysLeft === 0 ? "today" : row.daysLeft <= 3 ? "soon" : null;
        if (!kind) continue;
        const tag = `${row.period}:${kind}`;
        if (e.lastDeadlineReminder === tag) continue;
        await ctx.db.patch(e._id, { lastDeadlineReminder: tag });
        const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
        await notify(ctx, {
          audience: "employer",
          employerId: e._id,
          kind: `deadline_${kind}`,
          title:
            kind === "overdue"
              ? `${monthLabel} pension remittance is overdue`
              : kind === "today"
                ? `${monthLabel} pension remittance is due today`
                : `${monthLabel} pension remittance due in ${row.daysLeft} day${row.daysLeft === 1 ? "" : "s"}`,
          body:
            kind === "overdue"
              ? `The statutory deadline (${row.deadline}, 7 working days after salary) has passed. Late remittance attracts penalties under the Pension Reform Act 2014 — pay now to stop them growing.`
              : `Contributions for ${monthLabel} must reach your employees' PFAs by ${row.deadline}. Allow time for PFA posting.`,
          link: "/dashboard",
        });
        sent++;
        break;
      }
    }
    return { sent };
  },
});
