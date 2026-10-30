import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/convex/_generated/api";
import {
  approvedEmployer,
  ensureAdmin,
  newBackend,
  resetAdminCache,
  schedule,
  seedPfas,
  signedInAs,
  type Backend,
} from "./helpers";

let t: Backend;
beforeEach(async () => {
  resetAdminCache();
  t = newBackend();
  await seedPfas(t);
});
afterEach(() => vi.unstubAllEnvs());

describe("platform-admin bootstrap", () => {
  test("a random first sign-up cannot make itself platform admin", async () => {
    const stranger = await signedInAs(t, { email: "first-visitor@gmail.test" });
    await expect(stranger.client.mutation(api.pension.claimPlatformAdmin, {})).rejects.toThrow();
    const row = await t.run(async (ctx) => ctx.db.get(stranger.userId));
    expect(row?.role).toBeUndefined();
    const status = await stranger.client.query(api.pension.bootstrapAdminStatus, {});
    expect(status.eligible).toBe(false);
  });

  test("only an allow-listed operator email can bootstrap, and only once", async () => {
    vi.stubEnv("PENROUTE_BOOTSTRAP_ADMIN_EMAILS", "founder@penroute.net, cto@penroute.net");
    const other = await signedInAs(t, { email: "someone@else.test" });
    await expect(other.client.mutation(api.pension.claimPlatformAdmin, {})).rejects.toThrow();
    const founder = await signedInAs(t, { email: "Founder@Penroute.net" });
    expect((await founder.client.query(api.pension.bootstrapAdminStatus, {})).eligible).toBe(true);
    await founder.client.mutation(api.pension.claimPlatformAdmin, {});
    expect((await t.run((ctx) => ctx.db.get(founder.userId)))?.role).toBe("admin");
    const cto = await signedInAs(t, { email: "cto@penroute.net" });
    await expect(cto.client.mutation(api.pension.claimPlatformAdmin, {})).rejects.toThrow(/already/i);
  });
});

describe("demo workspace", () => {
  test("an admin loading the demo can never take over a real customer's workspace", async () => {
    const real = await approvedEmployer(t, "owner@realco.test", "RC-REAL-1");
    const admin = await ensureAdmin(t);
    await admin.client.mutation(api.pension.claimDemoEmployer, {}).catch(() => undefined);
    const emp = await t.run((ctx) => ctx.db.get(real.employerId));
    expect(emp?.ownerUserId).toBe(real.userId);
    const dash = await real.client.query(api.pension.getEmployerDashboard, {});
    expect(dash?.employer?._id).toBe(real.employerId);
  });

  test("demo seeding is disabled outside sandbox deployments", async () => {
    const admin = await ensureAdmin(t);
    await expect(admin.client.mutation(api.pension.seedDemoData, {})).rejects.toThrow(/sandbox/i);
  });
});

describe("registration & onboarding", () => {
  test("anonymous/guest sessions cannot register an employer", async () => {
    const guest = await signedInAs(t, { isAnonymous: true });
    await expect(
      guest.client.mutation(api.pension.registerEmployer, {
        name: "Ghost Ltd",
        rcNumber: "RC-GHOST",
        tin: "TIN-1",
        registeredAddress: "x",
        contactEmail: "a@b.test",
        contactPhone: "1",
        representativeName: "x",
      }),
    ).rejects.toThrow();
  });

  test("new employers are pending until an admin approves; pending cannot submit contributions", async () => {
    const owner = await signedInAs(t, { email: "hr@newco.test" });
    const { employerId } = await owner.client.mutation(api.pension.registerEmployer, {
      name: "NewCo Ltd",
      rcNumber: "RC-555",
      tin: "TIN-555",
      registeredAddress: "Abuja",
      contactEmail: "hr@newco.test",
      contactPhone: "+234",
      representativeName: "Ada",
    });
    const e = await t.run((ctx) => ctx.db.get(employerId));
    expect(e?.status).toBe("pending");
    await expect(
      owner.client.mutation(api.engine.prepareBatch, { year: 2026, month: 1, records: schedule(2) }),
    ).rejects.toThrow(/approved/i);
    // Duplicate RC number is rejected.
    const dup = await signedInAs(t, { email: "copy@cat.test" });
    await expect(
      dup.client.mutation(api.pension.registerEmployer, {
        name: "Copy",
        rcNumber: "RC-555",
        tin: "T",
        registeredAddress: "",
        contactEmail: "copy@cat.test",
        contactPhone: "",
        representativeName: "",
      }),
    ).rejects.toThrow(/already exists/);
  });
});

describe("tenant isolation", () => {
  test("employer B cannot read, pay or modify employer A's data", async () => {
    vi.stubEnv("PENROUTE_SANDBOX_MODE", "enabled");
    const a = await approvedEmployer(t, "a@a.test", "RC-A");
    const b = await approvedEmployer(t, "b@b.test", "RC-B");
    const { batchId } = await a.client.mutation(api.engine.prepareBatch, {
      year: 2026,
      month: 3,
      records: schedule(3),
    });
    const pfa = await t.run(async (ctx) => (await ctx.db.query("pfas").first())!);
    const { employeeId } = await a.client.mutation(api.pension.addEmployee, {
      fullName: "Ada A",
      employeeCode: "A-1",
      pensionPin: "PEN900001",
      pfaId: pfa._id,
    });

    await expect(b.client.query(api.pension.getBatchDetail, { batchId })).rejects.toThrow(/not authorized/i);
    await expect(b.client.mutation(api.engine.payBatch, { batchId })).rejects.toThrow(/not found/i);
    await expect(
      b.client.mutation(api.pension.updateEmployee, {
        employeeId,
        fullName: "Hacked",
        employeeCode: "X",
        pensionPin: "PEN900001",
        pfaId: pfa._id,
      }),
    ).rejects.toThrow(/not authorized/i);
    await expect(b.client.mutation(api.pension.toggleEmployeeActive, { employeeId })).rejects.toThrow(
      /not authorized/i,
    );
    expect(await b.client.query(api.engine.getLivePaymentContext, { batchId })).toBeNull();
    const bDash = await b.client.query(api.pension.getEmployerDashboard, {});
    expect(bDash?.batches).toHaveLength(0);
    // API key material never leaves the server.
    await a.client.mutation(api.employers.generateApiKey, {});
    const aDash = await a.client.query(api.pension.getEmployerDashboard, {});
    expect(aDash?.employer?.apiKeyHash).toBeUndefined();
    expect(aDash?.employer?.apiKey).toBeUndefined();
  });

  test("PFA operators see only their own PFA; employers cannot use admin or PFA functions", async () => {
    const pfas = await t.run((ctx) => ctx.db.query("pfas").take(2));
    const op = await signedInAs(t, { email: "ops@pfa.test", role: "pfa", pfaId: pfas[0]._id });
    expect(await op.client.query(api.pension.getEmployerDashboard, {})).toBeNull();
    await expect(op.client.query(api.pension.getPfaAllocations, { pfaId: pfas[1]._id })).rejects.toThrow();
    expect(await op.client.query(api.pension.getPfaAllocations, { pfaId: pfas[0]._id })).not.toBeNull();

    const emp = await approvedEmployer(t, "e@e.test", "RC-E");
    await expect(emp.client.query(api.pfaPortal.getOverview, {})).rejects.toThrow(/PFA portal access/);
    await expect(emp.client.mutation(api.admin.adminSetRailMode, { mode: "live" })).rejects.toThrow(/Admin/);
    await expect(
      emp.client.mutation(api.admin.adminSetEmployerStatus, { employerId: emp.employerId, status: "active" }),
    ).rejects.toThrow(/Admin/);
    await expect(emp.client.query(api.admin.getAdminOverview, {})).rejects.toThrow(/Admin/);
    await expect(emp.client.mutation(api.pricing.createTier, {} as never)).rejects.toThrow();
  });

  test("signed-out callers are refused by every privileged function", async () => {
    await expect(t.query(api.admin.getAdminOverview, {})).rejects.toThrow(/Not authenticated/);
    await expect(t.mutation(api.pension.registerEmployer, {
      name: "x", rcNumber: "x", tin: "x", registeredAddress: "", contactEmail: "a@b.c", contactPhone: "", representativeName: "",
    })).rejects.toThrow(/Not authenticated/);
    await expect(t.mutation(api.engine.prepareBatch, { year: 2026, month: 1, records: schedule(1) })).rejects.toThrow(
      /Not authenticated/,
    );
    expect(await t.query(api.pension.getEmployerDashboard, {})).toBeNull();
  });
});
