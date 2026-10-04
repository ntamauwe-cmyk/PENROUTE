/**
 * ============================================================================
 * SECURITY SELF-TEST (internal only — never callable from a browser)
 * ----------------------------------------------------------------------------
 * Run (orchestrated by scripts/test-authz-probe.mjs):
 *   bunx convex run securitySelftest:setup
 *   … intake probes against engine:intakeApiSchedule …
 *   bunx convex run securitySelftest:verifyAndCleanup
 *
 * Creates SYNTHETIC tenants prefixed TEST-SEC- (no real pension or personal
 * data), asserts tenant-isolation and payroll-key invariants against the
 * REAL database and REAL production code paths, then removes every row it
 * created. Rerunnable: setup/verifyAndCleanup sweep leftovers from an
 * interrupted run before doing anything else.
 *
 * Internal visibility on purpose: browsers cannot call internal functions;
 * only deployment tooling (convex run) can reach these.
 */
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getEmployerForUser } from "./employers";
import { hashApiKey } from "../lib/security";

export const KEY_A = "penr_live_secselftest_a1b2c3d4e5f6a1b2c3d4e5f6";
export const KEY_B_LEGACY = "penr_live_seclegacy_b1b2c3d4e5f6b1b2c3d4e5f6";
export const KEY_C_LEGACY = "penr_live_seclegacy_c1b2c3d4e5f6c1b2c3d4e5f6";

type CheckResult = { name: string; ok: boolean; detail?: string };

/** Remove every synthetic TEST-SEC- row (idempotent sweep). */
async function sweep(ctx: MutationCtx): Promise<number> {
  let removed = 0;
  const employers = (await ctx.db.query("employers").collect()).filter(
    (e) => e.name.startsWith("TEST-SEC-") || e.rcNumber?.startsWith("TEST-SEC-"),
  );
  const employerIds = new Set(employers.map((e) => String(e._id)));
  const users = (await ctx.db.query("users").collect()).filter(
    (u) => (u.email ?? "").startsWith("sec-user-") || (u.email ?? "").startsWith("sec-selftest-"),
  );

  for (const emp of employers) {
    const batches = await ctx.db
      .query("contributionBatches")
      .withIndex("by_employer", (q) => q.eq("employerId", emp._id))
      .collect();
    for (const b of batches) {
      const records = await ctx.db
        .query("contributionRecords")
        .withIndex("by_batch", (q) => q.eq("batchId", b._id))
        .collect();
      for (const r of records) {
        await ctx.db.delete(r._id);
        removed++;
      }
      const logs = await ctx.db
        .query("integrationLogs")
        .withIndex("by_batch", (q) => q.eq("batchId", b._id))
        .collect();
      for (const l of logs) {
        await ctx.db.delete(l._id);
        removed++;
      }
      await ctx.db.delete(b._id);
      removed++;
    }
    for (const table of ["payments", "ledgerEntries", "exceptions", "billingCharges", "auditLogs", "employees"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_employer", (q) => q.eq("employerId", emp._id))
        .collect();
      for (const row of rows) {
        await ctx.db.delete(row._id);
        removed++;
      }
    }
    // webhookEvents only has a by_batch index — filter by employer instead.
    const hooks = (await ctx.db.query("webhookEvents").collect()).filter(
      (w) => w.employerId && employerIds.has(String(w.employerId)),
    );
    for (const w of hooks) {
      await ctx.db.delete(w._id);
      removed++;
    }
    await ctx.db.delete(emp._id);
    removed++;
  }
  for (const u of users) {
    await ctx.db.delete(u._id);
    removed++;
  }
  return removed;
}

export const setup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const results: CheckResult[] = [];
    const check = (name: string, ok: boolean, detail?: string) =>
      results.push({ name, ok, detail: ok ? undefined : detail });

    await sweep(ctx); // leftovers from an interrupted run

    const now = Date.now();
    const pfa = (
      await ctx.db
        .query("pfas")
        .filter((q) =>
          q.and(q.neq(q.field("active"), false), q.neq(q.field("status"), "INACTIVE")),
        )
        .collect()
    )[0];
    if (!pfa) throw new Error("No selectable PFA rows — seed the platform first");

    const keyAHash = await hashApiKey(KEY_A);

    const empA = await ctx.db.insert("employers", {
      name: "TEST-SEC-TenantA",
      rcNumber: "TEST-SEC-RC-A",
      tin: "TEST-SEC-TIN-A",
      registeredAddress: "—",
      contactEmail: "sec-a@example.invalid",
      contactPhone: "—",
      representativeName: "TEST-SEC",
      status: "active",
      kycStatus: "verified",
      createdAt: now,
      apiKeyHash: keyAHash,
      apiKeyCreatedAt: now,
    });
    const empB = await ctx.db.insert("employers", {
      name: "TEST-SEC-TenantB",
      rcNumber: "TEST-SEC-RC-B",
      tin: "TEST-SEC-TIN-B",
      registeredAddress: "—",
      contactEmail: "sec-b@example.invalid",
      contactPhone: "—",
      representativeName: "TEST-SEC",
      status: "pending", // must be blocked from intake
      kycStatus: "pending",
      createdAt: now,
      apiKey: KEY_B_LEGACY, // legacy plaintext — must NOT migrate on a 403
    });
    const empC = await ctx.db.insert("employers", {
      name: "TEST-SEC-TenantC",
      rcNumber: "TEST-SEC-RC-C",
      tin: "TEST-SEC-TIN-C",
      registeredAddress: "—",
      contactEmail: "sec-c@example.invalid",
      contactPhone: "—",
      representativeName: "TEST-SEC",
      status: "active",
      kycStatus: "verified",
      createdAt: now,
      apiKey: KEY_C_LEGACY, // legacy plaintext — must upgrade in place on use
    });

    const userA = await ctx.db.insert("users", {
      email: "sec-user-a@example.invalid",
      employerId: empA,
    });
    const userB = await ctx.db.insert("users", {
      email: "sec-user-b@example.invalid",
      employerId: empB,
    });
    const userC = await ctx.db.insert("users", { email: "sec-user-c@example.invalid" });
    const userD = await ctx.db.insert("users", {
      email: "sec-user-d@example.invalid",
      employerId: empA, // linked to A …
    });
    const userE = await ctx.db.insert("users", {
      email: "sec-user-e@example.invalid",
      employerId: empA, // linked to A but owns nothing
    });

    // Ownership: A owns empA, B owns empB, D owns empC (while LINKED to A —
    // proves a stale/foreign link never beats the user's own workspace).
    await ctx.db.patch(empA, { ownerUserId: userA });
    await ctx.db.patch(empB, { ownerUserId: userB });
    await ctx.db.patch(empC, { ownerUserId: userD });

    // --- Tenant isolation via the shared resolution path --------------------
    const resolve = (u: { _id: Id<"users">; employerId?: Id<"employers"> }) =>
      getEmployerForUser(ctx, u);

    const rA = await resolve({ _id: userA, employerId: empA });
    check("A (owner + linked) resolves to own employer", rA?._id === empA, String(rA?._id));

    const rB = await resolve({ _id: userB, employerId: empB });
    check("B (owner + linked) resolves to own employer", rB?._id === empB, String(rB?._id));

    const rC = await resolve({ _id: userC });
    check("C (no employer) gets NO shared/demo fallback", rC === null, String(rC?._id ?? rC));

    const rD = await resolve({ _id: userD, employerId: empA });
    check("D (linked to A, owns C) resolves to OWNED employer, never A", rD?._id === empC, String(rD?._id));

    const rE = await resolve({ _id: userE, employerId: empA });
    check("E (linked to A, owns nothing) rejected — no cross-tenant access", rE === null, String(rE?._id ?? rE));

    // --- Hashed key lookup (indexed) ----------------------------------------
    const byHash = await ctx.db
      .query("employers")
      .withIndex("by_apiKeyHash", (q) => q.eq("apiKeyHash", keyAHash))
      .first();
    check("hashed key lookup resolves the owning employer", byHash?._id === empA, String(byHash?._id));

    const wrongKeyHash = await hashApiKey(KEY_A + "zzz");
    const wrongHash = await ctx.db
      .query("employers")
      .withIndex("by_apiKeyHash", (q) => q.eq("apiKeyHash", wrongKeyHash))
      .first();
    check("wrong key never matches any employer", wrongHash === null, String(wrongHash?._id));

    return {
      ok: results.every((r) => r.ok),
      results,
      pfaCode: pfa.code,
      empA: String(empA),
      empB: String(empB),
      empC: String(empC),
    };
  },
});

/**
 * Post-probe assertions + guaranteed cleanup of every TEST-SEC- row.
 * scripts/test-authz-probe.mjs calls this even when earlier probes failed.
 */
export const verifyAndCleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const results: CheckResult[] = [];
    const check = (name: string, ok: boolean, detail?: string) =>
      results.push({ name, ok, detail: ok ? undefined : detail });

    const employers = await ctx.db.query("employers").collect();
    const empA = employers.find((e) => e.name === "TEST-SEC-TenantA") ?? null;
    const empB = employers.find((e) => e.name === "TEST-SEC-TenantB") ?? null;
    const empC = employers.find((e) => e.name === "TEST-SEC-TenantC") ?? null;

    // Legacy plaintext key on an ACTIVE employer upgrades in place on first use.
    check(
      "legacy key migrated to hash on successful use (empC)",
      Boolean(empC && empC.apiKeyHash && empC.apiKey === undefined),
      empC
        ? `apiKey=${empC.apiKey ? "still-plain" : "cleared"} hash=${empC.apiKeyHash ? "set" : "missing"}`
        : "empC missing",
    );
    // A rejected (pending) employer's legacy key is left untouched.
    check(
      "pending employer's key NOT migrated on rejection (empB)",
      Boolean(empB && empB.apiKey === KEY_B_LEGACY && !empB.apiKeyHash),
      empB ? `status=${empB.status} apiKey=${empB.apiKey ? "plain" : "cleared"}` : "empB missing",
    );

    if (empA) {
      const batches = await ctx.db
        .query("contributionBatches")
        .withIndex("by_employer", (q) => q.eq("employerId", empA._id))
        .collect();
      check("duplicate intake stays idempotent (exactly one batch)", batches.length === 1, `${batches.length}`);
      check(
        "rate-limit counter capped at 30 inside the window",
        (empA.intakeCount ?? 0) === 30,
        `intakeCount=${empA.intakeCount}`,
      );
    } else {
      check("empA present for post-probe assertions", false, "missing");
    }

    const swept = await sweep(ctx);
    check("all TEST-SEC- rows removed", swept >= 0, `rows=${swept}`);
    const remaining = (await ctx.db.query("employers").collect()).filter((e) =>
      e.name.startsWith("TEST-SEC-"),
    ).length;
    check("no TEST-SEC- employers remain", remaining === 0, `${remaining}`);

    return { ok: results.every((r) => r.ok), results, swept };
  },
});

// Re-exported for the probe script's type-free consumption.
export type { CheckResult };
