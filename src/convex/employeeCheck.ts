import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { hashApiKey } from "../lib/security";

// ============================================================================
// EMPLOYEE SELF-SERVICE — "Has my pension been paid?"
// An employee proves who they are with three facts only they and their
// employer know together: RSA PIN + employee ID + surname. They then see
// ONLY their own contribution lines. Failed attempts are throttled per PIN
// (5 per hour) so the form cannot be used to guess PINs, and the failure
// message never says which field was wrong.
// A mutation (not a query) so each attempt is counted.
// ============================================================================

const MAX_FAILURES = 5;
const WINDOW_MS = 60 * 60 * 1000;
const GENERIC = "We couldn't match those details. Check your RSA PIN, staff ID and surname exactly as your employer has them.";

const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, " ");

export const checkMyContributions = mutation({
  args: { pensionPin: v.string(), employeeCode: v.string(), surname: v.string() },
  handler: async (ctx, { pensionPin, employeeCode, surname }) => {
    const pin = pensionPin.toUpperCase().replace(/\s/g, "");
    const code = norm(employeeCode);
    const last = norm(surname);
    if (pin.length < 6 || pin.length > 24 || !code || code.length > 60 || last.length < 2 || last.length > 60) {
      return { ok: false as const, error: GENERIC };
    }

    const pinHash = await hashApiKey(`lookup:${pin}`);
    const now = Date.now();
    const throttle = await ctx.db
      .query("employeeLookups")
      .withIndex("by_pinHash", (q) => q.eq("pinHash", pinHash))
      .first();
    const inWindow = throttle && now - throttle.windowStart < WINDOW_MS;
    if (inWindow && throttle.failures >= MAX_FAILURES) {
      return { ok: false as const, error: "Too many attempts for this PIN. Please try again in an hour." };
    }

    const candidates = await ctx.db
      .query("employees")
      .withIndex("by_pin", (q) => q.eq("pensionPin", pin))
      .take(20);
    const surnameMatches = (fullName: string) => norm(fullName).split(" ").includes(last);
    const match = candidates.find((e) => norm(e.employeeCode) === code && surnameMatches(e.fullName));

    if (!match) {
      if (throttle && inWindow) {
        await ctx.db.patch(throttle._id, { failures: throttle.failures + 1 });
      } else if (throttle) {
        await ctx.db.patch(throttle._id, { windowStart: now, failures: 1 });
      } else {
        await ctx.db.insert("employeeLookups", { pinHash, windowStart: now, failures: 1 });
      }
      // RETURN (not throw): a thrown error would roll back the attempt
      // counter written above, making the throttle useless.
      return { ok: false as const, error: GENERIC };
    }
    if (throttle) await ctx.db.delete(throttle._id);

    // This person's contribution lines (same PIN and same surname), newest first.
    const records = (
      await ctx.db
        .query("contributionRecords")
        .withIndex("by_pin_period", (q) => q.eq("pensionPin", pin))
        .order("desc")
        .take(60)
    ).filter((r) => r.validationStatus === "valid" && surnameMatches(r.fullName));

    const lines = [];
    for (const r of records) {
      const [batch, pfa, employer] = await Promise.all([
        ctx.db.get(r.batchId),
        ctx.db.get(r.pfaId),
        ctx.db.get(r.employerId),
      ]);
      if (!batch) continue;
      const paid = batch.paymentStatus === "successful";
      const posted = paid && r.settlementStatus === "settled" && r.pfaStatus === "posted";
      lines.push({
        period: `${r.contributionYear}-${String(r.contributionMonth).padStart(2, "0")}`,
        year: r.contributionYear,
        month: r.contributionMonth,
        employerName: employer?.name ?? "Your employer",
        pfaName: pfa?.name ?? "Your PFA",
        employeeKobo: r.employeeContribution,
        employerKobo: r.employerContribution,
        totalKobo: r.totalAmount,
        status: posted ? "posted" : paid ? "paid_awaiting_pfa" : batch.paymentStatus === "failed" ? "payment_failed" : "not_paid",
        paidOn: paid ? batch.paymentDate ?? null : null,
      });
    }
    return {
      ok: true as const,
      firstName: match.fullName.split(" ")[0],
      pfaName: (await ctx.db.get(match.pfaId))?.name ?? null,
      lines: lines.sort((a, b) => b.year * 12 + b.month - (a.year * 12 + a.month)),
    };
  },
});
