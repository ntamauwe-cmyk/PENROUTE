import { beforeEach, describe, expect, test } from "vitest";
import { api } from "../src/convex/_generated/api";
import { newBackend, signedInAs, type Backend } from "./helpers";

let t: Backend;
beforeEach(() => {
  t = newBackend();
});

async function feeKobo() {
  return t.run(async (ctx) => {
    const row = await ctx.db.query("systemConfig").withIndex("by_key", (q) => q.eq("key", "per_employee_fee_kobo")).first();
    return row?.value ?? null;
  });
}

describe("maker-checker for fees and pricing", () => {
  test("a proposed fee does not change anything until a different approver approves it", async () => {
    const maker = await signedInAs(t, { email: "ops@penroute.test", role: "admin" });
    const checker = await signedInAs(t, { email: "ceo@penroute.test", role: "admin" });
    await t.run((ctx) => ctx.db.patch(checker.userId, { pricingApprover: true }));

    const res = await maker.client.mutation(api.admin.adminUpdateFee, { perEmployeeFeeKobo: 1200 });
    expect(res.pending).toBe(true);
    expect(await feeKobo()).toBeNull(); // nothing changed yet

    // The maker cannot approve their own change, and lacks authority anyway.
    await expect(maker.client.mutation(api.approvals.approvePricingChange, { requestId: res.requestId })).rejects.toThrow(
      /fee-approval authority/,
    );
    // Even an approver cannot approve their OWN proposal.
    const own = await checker.client.mutation(api.admin.adminUpdateFee, { perEmployeeFeeKobo: 1500 });
    await expect(checker.client.mutation(api.approvals.approvePricingChange, { requestId: own.requestId })).rejects.toThrow(
      /cannot approve a change you proposed/,
    );
    // Duplicate proposals are refused.
    await expect(maker.client.mutation(api.admin.adminUpdateFee, { perEmployeeFeeKobo: 1200 })).rejects.toThrow(/identical/);

    await checker.client.mutation(api.approvals.approvePricingChange, { requestId: res.requestId });
    expect(await feeKobo()).toBe(1200);
    const tiers = await t.run((ctx) => ctx.db.query("pricingTiers").collect());
    expect(tiers.filter((x) => x.active).every((x) => x.feePerPostingKobo === 1200)).toBe(true);
    await expect(checker.client.mutation(api.approvals.approvePricingChange, { requestId: res.requestId })).rejects.toThrow(
      /already approved/,
    );

    // Audit shows both people.
    const audit = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audit.some((a) => a.action === "update_fee_config" && a.actor.includes("ops@penroute.test") && a.actor.includes("ceo@penroute.test"))).toBe(true);

    // The proposer can withdraw; an approver must give a reason to reject.
    const w = await maker.client.mutation(api.admin.adminUpdateFee, { perEmployeeFeeKobo: 1300 });
    await expect(checker.client.mutation(api.approvals.rejectPricingChange, { requestId: w.requestId, note: " " })).rejects.toThrow(/reason/);
    const done = await maker.client.mutation(api.approvals.rejectPricingChange, { requestId: w.requestId, note: "" });
    expect(done.status).toBe("cancelled");
    expect(await feeKobo()).toBe(1200);
  });

  test("tier and plan price edits are proposals too; employers cannot propose or approve", async () => {
    const maker = await signedInAs(t, { email: "ops@penroute.test", role: "admin" });
    const checker = await signedInAs(t, { email: "ceo@penroute.test", role: "admin" });
    await t.run((ctx) => ctx.db.patch(checker.userId, { pricingApprover: true }));
    await maker.client.mutation(api.pricing.initializePricing, {});
    const tier = await t.run(async (ctx) => (await ctx.db.query("pricingTiers").first())!);

    const r = await maker.client.mutation(api.pricing.updateTier, { tierId: tier._id, feePerPostingKobo: 777 });
    expect(r.pending).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(tier._id)))!.feePerPostingKobo).toBe(tier.feePerPostingKobo);
    const list = await checker.client.query(api.approvals.listPricingRequests, {});
    expect(list.pending[0].summary).toMatch(/₦7\.77/);
    expect(list.pending[0].canApprove).toBe(true);
    await checker.client.mutation(api.approvals.approvePricingChange, { requestId: r.requestId });
    const active = await t.run((ctx) => ctx.db.query("pricingTiers").collect());
    expect(active.some((x) => x.code === tier.code && x.active && x.feePerPostingKobo === 777)).toBe(true);

    const employer = await signedInAs(t, { email: "hr@co.test" });
    await expect(employer.client.mutation(api.admin.adminUpdateFee, { perEmployeeFeeKobo: 1 })).rejects.toThrow(/Admin/);
    await expect(employer.client.query(api.approvals.listPricingRequests, {})).rejects.toThrow(/Admin/);
  });
});

describe("administrator team", () => {
  test("founder claims approval once; only approvers manage admins; never zero approvers", async () => {
    const { vi } = await import("vitest");
    vi.stubEnv("PENROUTE_BOOTSTRAP_ADMIN_EMAILS", "founder@penroute.test");
    const founder = await signedInAs(t, { email: "founder@penroute.test", role: "admin" });
    const ops = await signedInAs(t, { email: "ops@penroute.test" });
    expect((await founder.client.query(api.approvals.listAdmins, {})).canClaimApprover).toBe(true);
    await founder.client.mutation(api.approvals.claimApproverAuthority, {});
    await expect(founder.client.mutation(api.approvals.claimApproverAuthority, {})).rejects.toThrow(/already exists/);

    await founder.client.mutation(api.approvals.setAdminAccess, { email: "ops@penroute.test", admin: true, pricingApprover: false });
    expect((await t.run((ctx) => ctx.db.get(ops.userId)))?.role).toBe("admin");
    // A non-approver admin cannot manage the team.
    await expect(
      ops.client.mutation(api.approvals.setAdminAccess, { email: "ops@penroute.test", admin: true, pricingApprover: true }),
    ).rejects.toThrow(/fee-approval authority/);
    // The last approver cannot be removed / remove themselves.
    await expect(
      founder.client.mutation(api.approvals.setAdminAccess, { email: "founder@penroute.test", admin: true, pricingApprover: false }),
    ).rejects.toThrow(/own authority/);
    await expect(
      founder.client.mutation(api.approvals.setAdminAccess, { email: "nobody@x.test", admin: true, pricingApprover: false }),
    ).rejects.toThrow(/signed in/);
    // Full maker-checker with two real people.
    const r = await ops.client.mutation(api.admin.adminUpdateFee, { perEmployeeFeeKobo: 1000 });
    await founder.client.mutation(api.approvals.approvePricingChange, { requestId: r.requestId });
    expect(await feeKobo()).toBe(1000);
    vi.unstubAllEnvs();
  });
});
