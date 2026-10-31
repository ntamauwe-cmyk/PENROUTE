import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/convex/_generated/api";
import { newBackend, signedInAs, type Backend } from "./helpers";

let t: Backend;
beforeEach(() => {
  t = newBackend();
});
afterEach(() => vi.unstubAllEnvs());

async function feeKobo() {
  return t.run(async (ctx) => {
    const row = await ctx.db.query("systemConfig").withIndex("by_key", (q) => q.eq("key", "per_employee_fee_kobo")).first();
    return row?.value ?? null;
  });
}

async function team() {
  const superAdmin = await signedInAs(t, { email: "owner@penroute.test", role: "admin" });
  await t.run((ctx) => ctx.db.patch(superAdmin.userId, { superAdmin: true, pricingApprover: true }));
  const approver = await signedInAs(t, { email: "cfo@penroute.test", role: "admin" });
  await t.run((ctx) => ctx.db.patch(approver.userId, { pricingApprover: true }));
  const ops = await signedInAs(t, { email: "ops@penroute.test", role: "admin" });
  return { superAdmin, approver, ops };
}

describe("super admin and maker-checker pricing", () => {
  test("the super admin changes the fee directly", async () => {
    const { superAdmin } = await team();
    const res = await superAdmin.client.mutation(api.admin.adminUpdateFee, { perEmployeeFeeKobo: 1100 });
    expect("applied" in res && res.applied).toBe(true);
    expect(await feeKobo()).toBe(1100);
  });

  test("other admins only propose; super admin or an assigned approver approves; never self-approval", async () => {
    const { superAdmin, approver, ops } = await team();
    const res = await ops.client.mutation(api.admin.adminUpdateFee, { perEmployeeFeeKobo: 1200 });
    expect("pending" in res && res.pending).toBe(true);
    if (!("pending" in res)) throw new Error();
    expect(await feeKobo()).toBeNull();
    await expect(ops.client.mutation(api.approvals.approvePricingChange, { requestId: res.requestId })).rejects.toThrow(/super admin/);
    await expect(ops.client.mutation(api.admin.adminUpdateFee, { perEmployeeFeeKobo: 1200 })).rejects.toThrow(/identical/);

    // An assigned approver's OWN change still needs someone else.
    const own = await approver.client.mutation(api.admin.adminUpdateFee, { perEmployeeFeeKobo: 1500 });
    if (!("pending" in own)) throw new Error("approver should not apply directly");
    await expect(approver.client.mutation(api.approvals.approvePricingChange, { requestId: own.requestId })).rejects.toThrow(
      /cannot approve a change you proposed/,
    );

    await approver.client.mutation(api.approvals.approvePricingChange, { requestId: res.requestId });
    expect(await feeKobo()).toBe(1200);
    const audit = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audit.some((a) => a.action === "update_fee_config" && a.actor.includes("ops@") && a.actor.includes("cfo@"))).toBe(true);

    await superAdmin.client.mutation(api.approvals.approvePricingChange, { requestId: own.requestId });
    expect(await feeKobo()).toBe(1500);

    const w = await ops.client.mutation(api.admin.adminUpdateFee, { perEmployeeFeeKobo: 1300 });
    if (!("pending" in w)) throw new Error();
    await expect(approver.client.mutation(api.approvals.rejectPricingChange, { requestId: w.requestId, note: " " })).rejects.toThrow(/reason/);
    expect((await ops.client.mutation(api.approvals.rejectPricingChange, { requestId: w.requestId, note: "" })).status).toBe("cancelled");
  });

  test("tier price edits by a regular admin wait for approval", async () => {
    const { superAdmin, ops } = await team();
    await superAdmin.client.mutation(api.pricing.initializePricing, {});
    const tier = await t.run(async (ctx) => (await ctx.db.query("pricingTiers").first())!);
    const r = await ops.client.mutation(api.pricing.updateTier, { tierId: tier._id, feePerPostingKobo: 777 });
    if (!("pending" in r)) throw new Error();
    expect((await t.run((ctx) => ctx.db.get(tier._id)))!.feePerPostingKobo).toBe(tier.feePerPostingKobo);
    const list = await superAdmin.client.query(api.approvals.listPricingRequests, {});
    expect(list.pending[0].summary).toMatch(/₦7\.77/);
    await superAdmin.client.mutation(api.approvals.approvePricingChange, { requestId: r.requestId });
    const tiers = await t.run((ctx) => ctx.db.query("pricingTiers").collect());
    expect(tiers.some((x) => x.code === tier.code && x.active && x.feePerPostingKobo === 777)).toBe(true);

    const employer = await signedInAs(t, { email: "hr@co.test" });
    await expect(employer.client.mutation(api.admin.adminUpdateFee, { perEmployeeFeeKobo: 1 })).rejects.toThrow(/Admin/);
  });
});

describe("administrator team", () => {
  test("only the super admin manages admins and approvers; founder claims super admin once", async () => {
    vi.stubEnv("PENROUTE_BOOTSTRAP_ADMIN_EMAILS", "founder@penroute.test");
    const founder = await signedInAs(t, { email: "founder@penroute.test", role: "admin" });
    const ops = await signedInAs(t, { email: "ops@penroute.test" });
    const cfo = await signedInAs(t, { email: "cfo@penroute.test" });
    expect((await founder.client.query(api.approvals.listAdmins, {})).canClaimApprover).toBe(true);
    await founder.client.mutation(api.approvals.claimApproverAuthority, {});
    await expect(founder.client.mutation(api.approvals.claimApproverAuthority, {})).rejects.toThrow(/already exists/);

    await founder.client.mutation(api.approvals.setAdminAccess, { email: "ops@penroute.test", admin: true, pricingApprover: false });
    await founder.client.mutation(api.approvals.setAdminAccess, { email: "cfo@penroute.test", admin: true, pricingApprover: true });
    // An approver is NOT a super admin: cannot manage the team.
    await expect(
      cfo.client.mutation(api.approvals.setAdminAccess, { email: "ops@penroute.test", admin: true, pricingApprover: true }),
    ).rejects.toThrow(/Only the super admin/);
    // Nobody can strip the super admin.
    await expect(
      founder.client.mutation(api.approvals.setAdminAccess, { email: "founder@penroute.test", admin: false, pricingApprover: false }),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      founder.client.mutation(api.approvals.setAdminAccess, { email: "nobody@x.test", admin: true, pricingApprover: false }),
    ).rejects.toThrow(/signed in/);

    // Founder's own fee change applies at once; ops' needs the CFO.
    await founder.client.mutation(api.admin.adminUpdateFee, { perEmployeeFeeKobo: 900 });
    expect(await feeKobo()).toBe(900);
    const r = await ops.client.mutation(api.admin.adminUpdateFee, { perEmployeeFeeKobo: 1000 });
    if (!("pending" in r)) throw new Error();
    await cfo.client.mutation(api.approvals.approvePricingChange, { requestId: r.requestId });
    expect(await feeKobo()).toBe(1000);
    void ops;
  });
});
