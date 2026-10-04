import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { getCurrentEmployer } from "./employers";

/** SECURITY: payroll API keys (and their hashes) are server-only and are
 *  never included in any client-facing payload. */
function safeEmployer(employer: Doc<"employers">) {
  const safe = { ...employer };
  delete safe.apiKey;
  delete safe.apiKeyHash;
  return safe;
}

/**
 * Rows for the current contribution cycle: the roster of employees and
 * whether they already have a record in the selected period's batch.
 */
export const getReadyEmployees = query({
  args: {
    year: v.number(),
    month: v.number(),
  },
  handler: async (ctx, { year, month }) => {
    const employer = await getCurrentEmployer(ctx);
    if (!employer) return { employer: null, employees: [], existingBatch: null };

    const employees = await ctx.db
      .query("employees")
      .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
      .take(10_000);

    // find batch for this period if one exists
    const allBatches = await ctx.db
      .query("contributionBatches")
      .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
      .take(10_000);
    const existingBatch =
      allBatches.find(
        (b) =>
          b.contributionYear === year &&
          b.contributionMonth === month &&
          b.status !== "failed",
      ) ?? null;

    const records = existingBatch
      ? await ctx.db
          .query("contributionRecords")
          .withIndex("by_batch", (q) => q.eq("batchId", existingBatch._id))
          .take(10_000)
      : [];

    const recordByPin = new Map(records.map((r) => [r.pensionPin, r]));

    return {
      employer: safeEmployer(employer),
      employees: employees
        .filter((e) => e.active)
        .sort((a, b) => a.fullName.localeCompare(b.fullName))
        .map((e) => {
          const rec = recordByPin.get(e.pensionPin);
          return {
            _id: e._id,
            employeeCode: e.employeeCode,
            fullName: e.fullName,
            pensionPin: e.pensionPin,
            pfaId: e.pfaId,
            record: rec
              ? {
                  employeeContribution: rec.employeeContribution,
                  employerContribution: rec.employerContribution,
                  validationStatus: rec.validationStatus,
                  allocationStatus: rec.allocationStatus,
                  settlementStatus: rec.settlementStatus,
                  pfaStatus: rec.pfaStatus,
                }
              : null,
          };
        }),
      existingBatch,
    };
  },
});

/** History for Statements: batches with amounts and dates. */
export const getContributionHistory = query({
  args: {},
  handler: async (ctx) => {
    const employer = await getCurrentEmployer(ctx);
    if (!employer) return { employer: null, batches: [] };

    const batches = await ctx.db
      .query("contributionBatches")
      .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
      .take(10_000);

    return {
      employer: safeEmployer(employer),
      batches: batches.sort((a, b) => b.createdAt - a.createdAt),
    };
  },
});
