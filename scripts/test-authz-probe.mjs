#!/usr/bin/env node
/**
 * SECURITY PROBES — run: node scripts/test-authz-probe.mjs
 *
 * Layer A: Convex security selftest against the dev deployment using
 *          SYNTHETIC TEST-SEC- data (tenant isolation, payroll API key
 *          hashing/migration, approval gating, idempotency, rate limiting).
 * Layer B: unauthenticated denial probes — every privileged public function
 *          must reject a caller with no identity.
 *
 * The selftest rows are always removed (verifyAndCleanup runs even on
 * failure). Exit code 0 = all probes passed.
 */
import { spawnSync } from "node:child_process";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` — ${String(detail).slice(0, 400)}` : ""}`);
}

function run(args) {
  const r = spawnSync("bunx", ["convex", "run", ...args], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function runJson(fn, args) {
  const r = run([fn, JSON.stringify(args ?? {})]);
  if (r.code !== 0) return { error: true, out: r.out };
  const text = (r.out ?? "").trim();
  // `convex run` prints an empty string for a null result.
  if (text === "") return { value: null };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: true, out: r.out };
  }
}

function inlineQuery(code) {
  const r = run(["--inline-query", code]);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}

const DENY_RE =
  /Not authenticated|Admin access required|restricted to platform admins|PFA portal access required|Only platform admins|not approved/i;

function expectDenied(name, fn, args) {
  const r = run([fn, JSON.stringify(args ?? {})]);
  const denied = r.code !== 0 && DENY_RE.test(r.out);
  record(name, denied, denied ? undefined : `exit=${r.code} out=${r.out.slice(0, 300)}`);
}

function expectNull(name, fn, args) {
  const res = runJson(fn, args);
  const ok = !res.error && (res.value === null || res.value === undefined);
  record(name, ok, ok ? undefined : `expected null, got ${JSON.stringify(res.value ?? res.out).slice(0, 200)}`);
}

function row(pfaCode) {
  return [
    {
      fullName: "TEST SEC ROW",
      employeeCode: "TEST-SEC-001",
      pensionPin: "TESTSEC001",
      pfaCode,
      employeeContribution: 1000,
      employerContribution: 1000,
    },
  ];
}

// ===========================================================================
// Layer A — tenant isolation + payroll API security (synthetic data)
// ===========================================================================
const batchIdCapture = { id: null };
const setup = runJson("securitySelftest:setup");
if (setup.error) {
  record("securitySelftest:setup", false, setup.out);
} else {
  record("securitySelftest:setup ran", true);
  for (const r of setup.value?.results ?? []) record(`selftest: ${r.name}`, r.ok, r.detail);
}

let intakeFailures = 0;
if (!setup.error) {
  const { pfaCode, empC } = setup.value;
  const base = { year: 2026, month: 12, records: row(pfaCode) };
  const KEY_A = "penr_live_secselftest_a1b2c3d4e5f6a1b2c3d4e5f6";
  const KEY_B = "penr_live_seclegacy_b1b2c3d4e5f6b1b2c3d4e5f6";
  const KEY_C = "penr_live_seclegacy_c1b2c3d4e5f6c1b2c3d4e5f6";
  void empC;

  const bogus = runJson("engine:intakeApiSchedule", { ...base, apiKey: "penr_live_0000000000000000000000000000" });
  record(
    "intake: unknown API key rejected with 401",
    !bogus.error && bogus.value?.ok === false && bogus.value?.status === 401,
    JSON.stringify(bogus.value ?? bogus.out).slice(0, 200),
  );

  const first = runJson("engine:intakeApiSchedule", { ...base, apiKey: KEY_A });
  record(
    "intake: hashed key accepted (approved employer)",
    !first.error && first.value?.ok === true && Boolean(first.value?.batchRef),
    JSON.stringify(first.value ?? first.out).slice(0, 200),
  );

  const dup = runJson("engine:intakeApiSchedule", { ...base, apiKey: KEY_A });
  record(
    "intake: repeat submission is idempotent (duplicate)",
    !dup.error && dup.value?.ok === true && dup.value?.duplicate === true,
    JSON.stringify(dup.value ?? dup.out).slice(0, 200),
  );

  const pending = runJson("engine:intakeApiSchedule", { ...base, apiKey: KEY_B });
  record(
    "intake: pending employer rejected with 403",
    !pending.error && pending.value?.ok === false && pending.value?.status === 403,
    JSON.stringify(pending.value ?? pending.out).slice(0, 200),
  );

  const legacy = runJson("engine:intakeApiSchedule", { ...base, apiKey: KEY_C });
  record(
    "intake: legacy plaintext key still accepted (no invalidation)",
    !legacy.error && legacy.value?.ok === true,
    JSON.stringify(legacy.value ?? legacy.out).slice(0, 200),
  );

  let sawRateLimit = false;
  let last = null;
  for (let i = 0; i < 40 && !sawRateLimit; i++) {
    last = runJson("engine:intakeApiSchedule", { ...base, apiKey: KEY_A });
    if (!last.error && last.value?.ok === false && last.value?.status === 429) sawRateLimit = true;
  }
  record("intake: durable rate limit kicks in (429)", sawRateLimit, JSON.stringify(last?.value ?? last?.out ?? "").slice(0, 200));
  if (!sawRateLimit) intakeFailures++;

  // Capture a format-valid batch id while the synthetic batch still exists
  // (used later by Layer B — the auth gate rejects before the row is read).
  batchIdCapture.id = inlineQuery('const b = await ctx.db.query("contributionBatches").first(); return b ? String(b._id) : null;');
} else {
  intakeFailures++;
}

// Always clean up the synthetic rows, even when probes failed.
const verify = runJson("securitySelftest:verifyAndCleanup");
if (verify.error) {
  record("securitySelftest:verifyAndCleanup", false, verify.out);
} else {
  for (const r of verify.value?.results ?? []) record(`selftest: ${r.name}`, r.ok, r.detail);
}

// ===========================================================================
// Layer B — unauthenticated denial probes (no identity whatsoever)
// ===========================================================================
const batchId =
  batchIdCapture.id ??
  inlineQuery('const b = await ctx.db.query("contributionBatches").first(); return b ? String(b._id) : null;');
const pfaId = inlineQuery('const p = await ctx.db.query("pfas").first(); return p ? String(p._id) : null;');
const exceptionId = inlineQuery('const e = await ctx.db.query("exceptions").first(); return e ? String(e._id) : null;');
const employerId = inlineQuery('const e = await ctx.db.query("employers").first(); return e ? String(e._id) : null;');

expectDenied("unauth denied: admin:getAdminOverview", "admin:getAdminOverview", {});
expectDenied("unauth denied: admin:listAllEmployers", "admin:listAllEmployers", {});
expectDenied("unauth denied: admin:listAllExceptions", "admin:listAllExceptions", {});
expectDenied("unauth denied: admin:adminListPfaIntegrations", "admin:adminListPfaIntegrations", {});
expectDenied("unauth denied: admin:adminSetEmployerStatus", "admin:adminSetEmployerStatus", {
  employerId: employerId ?? "js8pe8k3m2m3vq4h6p9r1s5t7u9w1y3z",
  status: "active",
});
expectDenied("unauth denied: pension:seedDemoData", "pension:seedDemoData", {});
expectDenied("unauth denied: pension:claimDemoEmployer", "pension:claimDemoEmployer", {});
expectDenied("unauth denied: pension:syncPfaDirectory", "pension:syncPfaDirectory", {});
expectDenied("unauth denied: pension:updateFeeConfig", "pension:updateFeeConfig", { perEmployeeFeeKobo: 1 });
expectDenied("unauth denied: adapters:testAdapters", "adapters:testAdapters", {
  pin: "TESTPIN01",
  pfaCode: "001",
  amountKobo: 100,
});
expectDenied("unauth denied: githubSyncData:stagePush", "githubSyncData:stagePush", { pushId: "probe-unauth" });
expectDenied("unauth denied: githubSyncData:githubPushStatus", "githubSyncData:githubPushStatus", {
  pushId: "probe-unauth",
});
expectDenied("unauth denied: githubSync:verifyRepo", "githubSync:verifyRepo", {
  owner: "ntamauwe-cmyk",
  repo: "PENROUTE",
});
expectDenied("unauth denied: githubSync:pushToGitHub", "githubSync:pushToGitHub", {
  owner: "ntamauwe-cmyk",
  repo: "PENROUTE",
  pushId: "probe-unauth",
});
expectDenied("unauth denied: pfaPortal:listSettlements", "pfaPortal:listSettlements", {});
expectDenied("unauth denied: pfaPortal:listContributions", "pfaPortal:listContributions", {});
expectDenied("unauth denied: pfaPortal:adminListAccess", "pfaPortal:adminListAccess", {});
expectDenied("unauth denied: pfaPortal:adminProvisionAccess", "pfaPortal:adminProvisionAccess", {
  email: "probe@example.invalid",
  pfaId: pfaId ?? "js8pe8k3m2m3vq4h6p9r1s5t7u9w1y3z",
});
expectDenied("unauth denied: pricing:getPricingForAdmin", "pricing:getPricingForAdmin", {});
expectDenied("unauth denied: pricing:initializePricing", "pricing:initializePricing", {});
expectDenied("unauth denied: engine:prepareBatch", "engine:prepareBatch", { year: 2026, month: 12, records: [] });
if (exceptionId) {
  expectDenied("unauth denied: pension:resolveException", "pension:resolveException", {
    exceptionId,
    notes: "probe",
  });
} else {
  console.log("SKIP  unauth denied: pension:resolveException — no exception rows in this deployment (ownership covered by static invariant test)");
}
if (pfaId) {
  expectDenied("unauth denied: pfaDispatch:testPfaConnection", "pfaDispatch:testPfaConnection", { pfaId });
} else {
  record("unauth denied: pfaDispatch:testPfaConnection", false, "no PFA row to build a valid id");
}
if (batchId) {
  expectDenied("unauth denied: engine:payBatch", "engine:payBatch", { batchId });
  expectDenied("unauth denied: engine:resumePipeline", "engine:resumePipeline", { batchId });
  expectNull("unauth read: engine:getLivePaymentContext → null", "engine:getLivePaymentContext", { batchId });
  expectNull("unauth read: pension:getBatchDetail → null", "pension:getBatchDetail", { batchId });
} else {
  record("unauth denied: engine:payBatch (batch-scoped)", false, "no batch rows in this deployment");
}

expectNull("unauth read: users:currentUser → null", "users:currentUser", {});
expectNull("unauth read: pension:getEmployerDashboard → null", "pension:getEmployerDashboard", {});
expectNull("unauth read: engine:getDraftSummary → null", "engine:getDraftSummary", { year: 2026, month: 1 });

// ===========================================================================
const failed = results.filter((r) => !r.ok);
console.log(
  `\n${failed.length === 0 ? "ALL SECURITY PROBES PASSED" : `${failed.length} PROBE(S) FAILED`} — ${results.length - failed.length} passed, ${failed.length} failed${intakeFailures ? ` (intake group incomplete: ${intakeFailures})` : ""}`,
);
process.exit(failed.length === 0 ? 0 : 1);
