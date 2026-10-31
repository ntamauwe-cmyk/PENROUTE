// ============================================================================
// STATUTORY COMPLIANCE ENGINE — Pension Reform Act 2014 (Nigeria)
// Shared by the Convex backend and the browser so every surface computes the
// same numbers.
//   - Minimum contributions: employer 10%, employee 8% of monthly emoluments
//     (basic salary + housing + transport allowances).
//   - Remittance: within 7 working days of the day salaries are paid.
// Public holidays are not modelled (weekends are) — the computed deadline is
// therefore never LATER than the statutory one, only possibly earlier.
// ============================================================================

export const EMPLOYEE_RATE = 0.08;
export const EMPLOYER_RATE = 0.1;
export const REMITTANCE_WORKING_DAYS = 7;
/** Day salaries are assumed to be paid when the employer has not said. */
export const DEFAULT_SALARY_PAY_DAY = 25;

/** Statutory minimum contributions (kobo) for a monthly emolument (kobo). */
export function statutoryContribution(emolumentKobo: number): { employeeKobo: number; employerKobo: number } {
  if (!Number.isFinite(emolumentKobo) || emolumentKobo <= 0) return { employeeKobo: 0, employerKobo: 0 };
  return {
    employeeKobo: Math.round(emolumentKobo * EMPLOYEE_RATE),
    employerKobo: Math.round(emolumentKobo * EMPLOYER_RATE),
  };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Salary payment date for a contribution month (UTC date, YYYY-MM-DD). */
export function salaryDate(year: number, month: number, payDay = DEFAULT_SALARY_PAY_DAY): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return ymd(new Date(Date.UTC(year, month - 1, Math.min(Math.max(1, Math.trunc(payDay)), last))));
}

/** Remittance deadline: 7 working days (Mon–Fri) after salary payment. */
export function remittanceDeadline(year: number, month: number, payDay = DEFAULT_SALARY_PAY_DAY): string {
  const d = new Date(`${salaryDate(year, month, payDay)}T00:00:00Z`);
  let added = 0;
  while (added < REMITTANCE_WORKING_DAYS) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) added++;
  }
  return ymd(d);
}

/** Whole days from `today` (YYYY-MM-DD) to `deadline`; negative = overdue. */
export function daysUntil(deadline: string, today: string): number {
  return Math.round((Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** Today's date in Lagos (UTC+1, no DST) as YYYY-MM-DD. */
export function lagosToday(now = Date.now()): string {
  return ymd(new Date(now + 60 * 60 * 1000));
}

export type CheckRow = {
  key: string;
  fullName: string;
  pensionPin: string;
  pfaCode: string;
  employeeKobo: number;
  employerKobo: number;
  emolumentKobo?: number | null;
};
export type PreviousRow = { pensionPin: string; pfaCode: string; employeeKobo: number; employerKobo: number };
export type Finding = { level: "block" | "warn" | "info"; pin?: string; message: string };

/**
 * Pre-payment checks: catch money mistakes BEFORE the employer pays.
 * block — cannot be paid as entered; warn — likely mistake; info — FYI.
 */
export function prePaymentChecks(rows: CheckRow[], previous: PreviousRow[] | null): Finding[] {
  const out: Finding[] = [];
  const name = (r: CheckRow) => `${r.fullName} (${r.pensionPin})`;
  for (const r of rows) {
    if (r.employeeKobo + r.employerKobo <= 0) {
      out.push({ level: "block", pin: r.pensionPin, message: `${name(r)} has no contribution amount.` });
      continue;
    }
    if (r.emolumentKobo && r.emolumentKobo > 0) {
      const min = statutoryContribution(r.emolumentKobo);
      if (r.employerKobo + 1 < min.employerKobo) {
        out.push({
          level: "warn",
          pin: r.pensionPin,
          message: `${name(r)}: employer share is below the 10% statutory minimum of ₦${(min.employerKobo / 100).toLocaleString("en-NG")}.`,
        });
      }
      if (r.employeeKobo + 1 < min.employeeKobo) {
        out.push({
          level: "warn",
          pin: r.pensionPin,
          message: `${name(r)}: employee share is below the 8% statutory minimum of ₦${(min.employeeKobo / 100).toLocaleString("en-NG")}.`,
        });
      }
    }
  }
  if (!previous || previous.length === 0) return out;

  const prevByPin = new Map(previous.map((p) => [p.pensionPin, p]));
  const nowPins = new Set(rows.map((r) => r.pensionPin));
  for (const r of rows) {
    const p = prevByPin.get(r.pensionPin);
    if (!p) {
      out.push({ level: "info", pin: r.pensionPin, message: `${name(r)} was not in last month's schedule (new joiner?).` });
      continue;
    }
    if (p.pfaCode !== r.pfaCode) {
      out.push({ level: "warn", pin: r.pensionPin, message: `${name(r)}: PFA changed since last month — confirm the RSA transfer was approved.` });
    }
    const before = p.employeeKobo + p.employerKobo;
    const after = r.employeeKobo + r.employerKobo;
    if (before > 0 && Math.abs(after - before) / before > 0.3) {
      out.push({
        level: "warn",
        pin: r.pensionPin,
        message: `${name(r)}: total changed ${after > before ? "up" : "down"} ${Math.round((Math.abs(after - before) / before) * 100)}% vs last month (₦${(before / 100).toLocaleString("en-NG")} → ₦${(after / 100).toLocaleString("en-NG")}).`,
      });
    }
  }
  const missing = previous.filter((p) => !nowPins.has(p.pensionPin));
  if (missing.length > 0) {
    out.push({
      level: "warn",
      message: `${missing.length} employee(s) paid last month are missing this month (${missing
        .slice(0, 5)
        .map((m) => m.pensionPin)
        .join(", ")}${missing.length > 5 ? ", …" : ""}). Leavers are fine; otherwise add them back.`,
    });
  }
  return out;
}
