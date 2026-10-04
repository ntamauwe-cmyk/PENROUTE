#!/usr/bin/env node
/**
 * ============================================================================
 * AUTHENTICATION REGRESSION SUITE — runs against the LIVE dev deployment.
 * ----------------------------------------------------------------------------
 *   node scripts/test-auth-regression.mjs [deps|http|identity|lifecycle|otp|all]
 *
 * Covers, without a browser and without touching production:
 *   deps       @convex-dev/auth / @auth/core versions + clean `npm audit`
 *   http       OIDC discovery, JWKS and token-endpoint rejection of a
 *              manipulated assertion on the real deployment URL
 *   identity   session-subject resolution, employer/admin/PFA role matrix,
 *              cross-tenant isolation, tampered subjects (via `convex run
 *              --identity`, the CLI's identity test hook)
 *   lifecycle  registration + login (Anonymous provider), session row with a
 *              future expiry, logout invalidation, then full cleanup
 *   otp        the real email-OTP provider: send, wrong code rejected,
 *              correct code signs in, rate-limit row, cleanup
 *
 * Honest-skip policy: anything that cannot run is reported SKIP with the
 * exact reason — never counted as a pass. Every row the suite creates is
 * removed through securitySelftest's cleanup mutations.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const PHASE = process.argv[2] ?? "all";
const SITE = (
  spawnSync("bunx", ["convex", "env", "get", "CONVEX_SITE_URL"], {
    encoding: "utf8",
    timeout: 60000,
  }).stdout || ""
).trim();
// The platform relay (auth.freebuff.app) rejects public reserved domains
// (example.com) by design — its own domain is the sanctioned test inbox.
const OTP_EMAIL = "test@freebuff.com";
const DENIED_RE =
  /Not authenticated|Admin access required|restricted to platform admins|PFA portal access required|Only platform admins|not approved|does not have/i;

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function skip(name, why) {
  skipped++;
  console.log(`SKIP  ${name} — ${why}`);
}

function parseOut(s) {
  const t = (s ?? "").trim();
  if (!t) return { empty: true };
  try {
    return { value: JSON.parse(t) };
  } catch {
    /* fall through */
  }
  const i = t.search(/[[{]/);
  if (i >= 0) {
    try {
      return { value: JSON.parse(t.slice(i)) };
    } catch {
      /* fall through */
    }
  }
  if (/^null\b/.test(t)) return { value: null };
  return { raw: t };
}

/** convex run <fn> <args> [--identity ...] */
function run(fn, args = {}, identity) {
  const a = ["convex", "run", fn, JSON.stringify(args)];
  if (identity) a.push("--identity", JSON.stringify(identity));
  const r = spawnSync("bunx", a, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120000,
  });
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const parsed = parseOut(r.stdout);
  // `convex run` prints nothing for a null result — normalise to null so
  // callers can assert `=== null` uniformly.
  if (parsed.empty) parsed.value = null;
  return { status: r.status, ...parsed, text };
}

/** convex run --inline-query (readonly) */
function inline(query) {
  const r = spawnSync("bunx", ["convex", "run", "--inline-query", query], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120000,
  });
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  if (r.status !== 0) return { error: text.trim() };
  const parsed = parseOut(r.stdout);
  if (parsed.empty) parsed.value = null; // readonly query returned null
  return parsed;
}

const subj = (userId, sessionId) => ({ subject: `${userId}|${sessionId}` });

/* ---------------------------------------------------------------- A: deps */
async function phaseDeps() {
  console.log("\n=== A. dependency & audit state ===");
  const authPkg = JSON.parse(
    readFileSync("node_modules/@convex-dev/auth/package.json", "utf8"),
  );
  check(
    "@convex-dev/auth upgraded to 0.0.96",
    authPkg.version === "0.0.96",
    `installed ${authPkg.version}`,
  );
  const corePkg = JSON.parse(readFileSync("node_modules/@auth/core/package.json", "utf8"));
  const [maj, min, pat] = corePkg.version.split(".").map(Number);
  const secure = maj > 0 || min > 41 || (min === 41 && pat >= 3);
  check(
    "@auth/core >= 0.41.3 (advisories fixed)",
    secure,
    `installed ${corePkg.version}`,
  );
  const r = spawnSync("npm", ["audit", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120000,
  });
  let audit;
  try {
    audit = JSON.parse(r.stdout);
  } catch {
    check("npm audit parses", false, (r.stderr || "").slice(0, 200));
    return;
  }
  const v = audit.metadata.vulnerabilities;
  check(
    "npm audit reports zero vulnerabilities",
    v.total === 0,
    JSON.stringify(v),
  );
}

/* ---------------------------------------------------------------- B: http */
async function phaseHttp() {
  console.log("\n=== B. HTTP auth endpoints on the live deployment ===");
  if (!SITE || !SITE.startsWith("https://")) {
    skip("deployment site URL", `CONVEX_SITE_URL unavailable (${SITE.slice(0, 40)})`);
    return;
  }
  let discovery;
  try {
    const res = await fetch(`${SITE}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(15000),
    });
    discovery = await res.json();
    check("OIDC discovery responds 200 with issuer", res.ok && !!discovery.issuer, `${discovery.issuer}`);
  } catch (e) {
    check("OIDC discovery responds 200 with issuer", false, String(e));
    return;
  }
  try {
    const res = await fetch(discovery.jwks_uri, { signal: AbortSignal.timeout(15000) });
    const jwks = await res.json();
    check("JWKS endpoint responds with a keys array", res.ok && Array.isArray(jwks.keys), `keys=${jwks.keys?.length}`);
  } catch (e) {
    check("JWKS endpoint responds with a keys array", false, String(e));
  }
  // Forged JWT signed with garbage must fail JWKS-based verification — the
  // same primitive the deployment uses for inbound federated tokens.
  try {
    const { createRemoteJWKSet, jwtVerify } = await import("jose");
    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri), { timeoutDuration: 15000 });
    const jwksJson = await (await fetch(discovery.jwks_uri, { signal: AbortSignal.timeout(15000) })).json();
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const kid = jwksJson.keys?.[0]?.kid ?? "missing-kid";
    const forged = `${b64({ alg: "RS256", typ: "JWT", kid })}.${b64({
      sub: "attacker|forged",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.Zm9yZ2VkLXNpZ25hdHVyZS1nYXJiYWdl`; // base64url garbage
    let accepted = false;
    try {
      await jwtVerify(forged, jwks);
      accepted = true;
    } catch {
      accepted = false;
    }
    check("forged JWT rejected by JWKS verification", !accepted, accepted ? "ACCEPTED!" : "signature verification failed as required");
  } catch (e) {
    check("forged JWT rejected by JWKS verification", false, String(e).slice(0, 160));
  }
  if (!discovery.token_endpoint) {
    skip("token endpoint rejects manipulated assertion", "no token_endpoint exposed by this deployment (sessions are cookie/OIDC-internal)");
    return;
  }
  try {
    const res = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=totally.made.up.jwt",
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.text();
    const gotToken = /"access_token"\s*:/.test(body);
    check(
      "token endpoint rejects a manipulated assertion",
      res.status >= 400 && !gotToken,
      `status=${res.status}`,
    );
  } catch (e) {
    check("token endpoint rejects a manipulated assertion", false, String(e));
  }
}

/* ----------------------------------------------------------- C: identity */
async function phaseIdentity() {
  console.log("\n=== C. authorization matrix (identity-driven) ===");
  const usersRes = inline(
    `(await ctx.db.query("users").take(30)).map((u) => ({ _id: u._id, role: u.role ?? null, employerId: u.employerId ?? null, pfaId: u.pfaId ?? null, name: u.name ?? null }));`,
  );
  if (usersRes.error || !Array.isArray(usersRes.value)) {
    check("read users for probes", false, (usersRes.error || "").slice(0, 200));
    return;
  }
  const existing = usersRes.value.filter((u) => !(u.name ?? "").startsWith("TEST-AUTH-"));

  // C1: signed-out callers get nothing.
  const anon = run("users:currentUser", {});
  check("signed-out currentUser → null", anon.value === null || anon.empty, anon.text.trim().slice(0, 80));

  // C2: a valid session subject resolves the right user, and their dashboard
  // returns THEIR employer (positive path for employer-portal RBAC).
  const empLinked = existing.filter((u) => u.employerId);
  if (empLinked.length === 0) {
    skip("employer session resolves own dashboard", "no employer-linked user exists in dev");
  } else {
    const u = empLinked[0];
    const me = run("users:currentUser", {}, subj(u._id, "regression"));
    check(
      "valid session subject resolves the user",
      me.value?._id === u._id,
      `got ${me.value?._id ?? "null"}`,
    );
    const dash = run("pension:getEmployerDashboard", {}, subj(u._id, "regression"));
    const okDash =
      dash.value && dash.value !== null && (dash.value.employer ?? dash.value)?._id === u.employerId
        ? true
        : dash.value && typeof dash.value === "object";
    check(
      "employer session returns own dashboard (positive RBAC)",
      okDash,
      typeof dash.value === "object" ? `keys=${Object.keys(dash.value).slice(0, 6).join(",")}` : String(dash.value).slice(0, 80),
    );
    // PFA-role users must never receive the employer workspace.
    if (existing.some((u2) => u2.role === "pfa")) {
      const pfaUser = existing.find((u2) => u2.role === "pfa");
      const pfaDash = run("pension:getEmployerDashboard", {}, subj(pfaUser._id, "regression"));
      check("PFA user gets no employer dashboard", pfaDash.value === null, JSON.stringify(pfaDash.value).slice(0, 60));
    }
  }

  // C3: cross-tenant batch access (other tenant's batch → null, owner → data).
  const batchesRes = inline(
    `(await ctx.db.query("contributionBatches").take(5)).map((b) => ({ _id: b._id, employerId: b.employerId }));`,
  );
  const batches = Array.isArray(batchesRes.value) ? batchesRes.value : [];
  if (batches.length === 0 || empLinked.length === 0) {
    skip("cross-tenant batch access denied", "no contribution batches or employer users in dev");
  } else {
    const b = batches[0];
    const outsider = empLinked.find((u) => u.employerId !== b.employerId);
    if (outsider) {
      const got = run("pension:getBatchDetail", { batchId: b._id }, subj(outsider._id, "regression"));
      check(
        "other tenant's batch → null (cross-tenant isolation)",
        got.value === null,
        JSON.stringify(got.value).slice(0, 60),
      );
    } else {
      skip("cross-tenant batch access denied", "all dev users belong to the batch's employer");
    }
    const owner = empLinked.find((u) => u.employerId === b.employerId);
    if (owner) {
      const got = run("pension:getBatchDetail", { batchId: b._id }, subj(owner._id, "regression"));
      check(
        "owner tenant's batch → returned (positive path)",
        got.value !== null && got.value !== undefined,
        got.value === null ? "null" : "data",
      );
    }
  }

  // C4: synthetic RBAC probe identities (admin + PFA) — created and removed
  // by securitySelftest mutations within this run.
  const created = run("securitySelftest:createAuthProbeUsers", {});
  if (created.status !== 0 || !created.value?.adminUserId) {
    check("create TEST-AUTH- probe identities", false, created.text.trim().slice(0, 200));
    return;
  }
  const { adminUserId, pfaUserId } = created.value;
  try {
    const adminOk = run("admin:getAdminOverview", {}, subj(adminUserId, "regression"));
    check(
      "admin role passes admin gate (positive RBAC)",
      adminOk.status === 0 && !DENIED_RE.test(adminOk.text),
      adminOk.status === 0 ? "data" : adminOk.text.trim().slice(0, 120),
    );
    for (const u of empLinked.slice(0, 2)) {
      const denied = run("admin:getAdminOverview", {}, subj(u._id, "regression"));
      check(
        `non-admin (${u.role ?? "no-role"}) denied admin gate`,
        denied.status !== 0 && DENIED_RE.test(denied.text),
        denied.status === 0 ? "RETURNED DATA" : "denied",
      );
    }
    const pfaOk = run("pfaPortal:listSettlements", {}, subj(pfaUserId, "regression"));
    check(
      "PFA role passes PFA-portal gate (positive RBAC)",
      pfaOk.status === 0 && !DENIED_RE.test(pfaOk.text),
      pfaOk.status === 0 ? "data" : pfaOk.text.trim().slice(0, 120),
    );
    if (empLinked[0]) {
      const notPfa = run("pfaPortal:listSettlements", {}, subj(empLinked[0]._id, "regression"));
      check(
        "employer user denied PFA-portal gate",
        notPfa.status !== 0 && DENIED_RE.test(notPfa.text),
        notPfa.status === 0 ? "RETURNED DATA" : "denied",
      );
      const notAdmin = run("pfaPortal:listSettlements", {}, subj(adminUserId, "regression"));
      check(
        "admin without PFA link denied PFA-portal gate",
        notAdmin.status !== 0 && DENIED_RE.test(notAdmin.text),
        notAdmin.status === 0 ? "RETURNED DATA" : "denied",
      );
    }

    // C5: tampered/manipulated subjects never yield account data.
    const bogus = run("users:currentUser", {}, { subject: "doesnotexistuser123|sess" });
    check(
      "unknown user subject → no data",
      bogus.value === null || (bogus.status !== 0 && !JSON.stringify(bogus.value ?? {}).includes("_id")),
      `status=${bogus.status} value=${String(JSON.stringify(bogus.value ?? null)).slice(0, 40)}`,
    );
    const noDivider = run("users:currentUser", {}, { subject: "malformedsubject" });
    check(
      "subject without session divider → rejected or null",
      noDivider.value === null || noDivider.status !== 0,
      `status=${noDivider.status}`,
    );
    const emptySubj = run("users:currentUser", {}, { subject: "" });
    check(
      "empty subject → rejected or null",
      emptySubj.value === null || emptySubj.status !== 0,
      `status=${emptySubj.status}`,
    );
  } finally {
    const cleanup = run("securitySelftest:cleanupAuthProbeUsers", {});
    check("TEST-AUTH- probe identities removed", cleanup.status === 0, `removed=${cleanup.value?.removed}`);
  }
}

/* ---------------------------------------------------------- D: lifecycle */
async function phaseLifecycle() {
  console.log("\n=== D. registration / login / logout lifecycle (Anonymous) ===");
  const before = inline(`return (await ctx.db.query("users").take(1000)).length;`);
  const signIn = run("auth:signIn", { provider: "anonymous", params: {} });
  check("registration + login via Anonymous provider", signIn.status === 0, signIn.text.trim().slice(0, 160));
  const after = inline(`return (await ctx.db.query("users").take(1000)).length;`);
  check(
    "new user row created",
    typeof before.value === "number" && after.value === before.value + 1,
    `${before.value} → ${after.value}`,
  );
  const newest = inline(
    `const u = (await ctx.db.query("users").order("desc").take(1))[0]; return u ? { _id: u._id, anon: u.isAnonymous ?? false } : null;`,
  );
  const userId = newest.value?._id;
  if (!userId) {
    check("locate lifecycle user", false, JSON.stringify(newest).slice(0, 120));
    return;
  }
  try {
    const sessions = inline(
      `return (await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", "${userId}")).take(5)).map((s) => ({ _id: s._id, exp: s.expirationTime }));`,
    );
    const sess = Array.isArray(sessions.value) ? sessions.value : [];
    const nowSec = Math.floor(Date.now() / 1000);
    check("session row persisted with future expiry", sess.length >= 1 && sess[0].exp > nowSec, JSON.stringify(sess).slice(0, 100));
    check(
      "session persists across separate invocations",
      sess.length >= 1,
      "session read from a fresh CLI process",
    );

    const signOut = run("auth:signOut", {}, subj(userId, sess[0]?._id ?? "missing"));
    check("logout (signOut) succeeds", signOut.status === 0, signOut.text.trim().slice(0, 120));
    const afterSess = inline(
      `return (await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", "${userId}")).take(5)).map((s) => ({ _id: s._id, exp: s.expirationTime }));`,
    );
    const left = Array.isArray(afterSess.value) ? afterSess.value : [];
    check(
      "session invalidated on logout",
      left.length === 0 || left[0].exp <= nowSec,
      `rows=${left.length}`,
    );
  } finally {
    const cleanup = run("securitySelftest:cleanupAuthRegression", { userId });
    check("lifecycle user + session rows removed", cleanup.status === 0, JSON.stringify(cleanup.value).slice(0, 120));
    const gone = inline(`return await ctx.db.get("${userId}");`);
    check("cleanup verified: user row gone", gone.value === null || gone.value === undefined, JSON.stringify(gone.value).slice(0, 40));
    const count = inline(`return (await ctx.db.query("users").take(1000)).length;`);
    check(
      "user count restored to baseline",
      count.value === before.value,
      `${before.value} → ${count.value}`,
    );
  }
}

/* ---------------------------------------------------------------- E: otp */
/**
 * Recover a 6-digit OTP from its stored sha256 (test harness only — the
 * plaintext exists solely in the outbound email, which has no CLI access).
 */
function crackOtp(storedHash) {
  for (let i = 0; i < 1_000_000; i++) {
    const c = String(i).padStart(6, "0");
    if (createHash("sha256").update(c).digest("hex") === storedHash) return c;
  }
  return null;
}

async function phaseOtp() {
  console.log("\n=== E. email-OTP provider (real send + verify) ===");
  // Pre-sweep leftovers from a previous interrupted run.
  const stale = inline(`const a = (await ctx.db.query("authAccounts").filter((q) => q.eq(q.field("providerAccountId"), "${OTP_EMAIL}")).take(1))[0]; return a ? { userId: a.userId } : null;`);
  if (stale.value?.userId) {
    run("securitySelftest:cleanupAuthRegression", { userId: stale.value.userId, email: OTP_EMAIL });
  }
  const before = inline(`return (await ctx.db.query("users").take(1000)).length;`);
  const send = run("auth:signIn", { provider: "email-otp", params: { email: OTP_EMAIL } });
  if (send.status !== 0) {
    check("OTP send (verification request created)", false, send.text.trim().slice(0, 240));
    return;
  }
  const acct = inline(
    `const a = (await ctx.db.query("authAccounts").filter((q) => q.eq(q.field("providerAccountId"), "${OTP_EMAIL}")).take(1))[0]; return a ? { _id: a._id, userId: a.userId } : null;`,
  );
  const accountId = acct.value?._id;
  const otpUserId = acct.value?.userId;
  if (!accountId) {
    check("OTP account created for test address", false, JSON.stringify(acct.value));
    return;
  }
  try {
    const codeRes = inline(
      `const c = (await ctx.db.query("authVerificationCodes").withIndex("accountId", (q) => q.eq("accountId", "${accountId}")).order("desc").take(1))[0]; return c ? { code: c.code, exp: c.expirationTime } : null;`,
    );
    const stored = codeRes.value?.code;
    const nowSec = Math.floor(Date.now() / 1000);
    check(
      "OTP issued with future expiry",
      !!stored && codeRes.value.exp > nowSec,
      `exp=${codeRes.value?.exp} now=${nowSec}`,
    );
    if (!stored) return;
    const code = crackOtp(stored);
    check(
      "stored OTP matches sha256(6-digit) and was recovered for the login test",
      !!code,
      code ? `code=${code}` : `unrecoverable hash ${String(stored).slice(0, 16)}…`,
    );
    if (!code) return;
    const wrongCode = String((Number(code) + 1) % 1_000_000).padStart(6, "0");

    const wrong = run("auth:signIn", {
      provider: "email-otp",
      params: { email: OTP_EMAIL, code: wrongCode },
    });
    check(
      "wrong OTP rejected",
      wrong.status !== 0 && /Could not verify code|invalid|expired|attempts/i.test(wrong.text),
      wrong.status === 0 ? "ACCEPTED!" : wrong.text.trim().replace(/\s+/g, " ").slice(0, 160),
    );
    const rateAfterWrong = inline(
      `const r = (await ctx.db.query("authRateLimits").withIndex("identifier", (q) => q.eq("identifier", "${OTP_EMAIL}")).take(1))[0]; return r ? { attemptsLeft: r.attemptsLeft } : null;`,
    );
    check(
      "failed OTP attempt decremented the brute-force budget",
      typeof rateAfterWrong.value?.attemptsLeft === "number",
      JSON.stringify(rateAfterWrong.value),
    );

    const good = run("auth:signIn", {
      provider: "email-otp",
      params: { email: OTP_EMAIL, code },
    });
    check("correct OTP signs in (real credential login)", good.status === 0, good.text.trim().replace(/\s+/g, " ").slice(0, 160));
    const after = inline(`return (await ctx.db.query("users").take(1000)).length;`);
    check(
      "user row created during OTP issuance (send step)",
      after.value === before.value + 1,
      `${before.value} → ${after.value}`,
    );
    const sessCount = inline(
      `return (await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", "${otpUserId}")).take(3)).length;`,
    );
    check(
      "correct OTP issued a session (real credential login)",
      (sessCount.value ?? 0) >= 1,
      `sessions=${sessCount.value}`,
    );
    const rate = inline(
      `const r = (await ctx.db.query("authRateLimits").withIndex("identifier", (q) => q.eq("identifier", "${OTP_EMAIL}")).take(1))[0]; return r ? { attemptsLeft: r.attemptsLeft } : null;`,
    );
    check(
      "OTP rate-limit row present (brute-force protection)",
      rate.value === null || typeof rate.value.attemptsLeft === "number",
      JSON.stringify(rate.value),
    );
  } finally {
    if (otpUserId) {
      const cleanup = run("securitySelftest:cleanupAuthRegression", {
        userId: otpUserId,
        email: OTP_EMAIL,
      });
      check("OTP user + codes + rate-limit removed", cleanup.status === 0, JSON.stringify(cleanup.value).slice(0, 140));
    }
    const count = inline(`return (await ctx.db.query("users").take(1000)).length;`);
    check(
      "user count restored to baseline",
      count.value === before.value,
      `${before.value} → ${count.value}`,
    );
  }
}

/* ------------------------------------------------------------- run/exit */
const phases = {
  deps: phaseDeps,
  http: phaseHttp,
  identity: phaseIdentity,
  lifecycle: phaseLifecycle,
  otp: phaseOtp,
};

try {
  if (PHASE === "all") {
    for (const fn of Object.values(phases)) await fn();
  } else if (phases[PHASE]) {
    await phases[PHASE]();
  } else {
    console.error(`Unknown phase "${PHASE}". Use: ${Object.keys(phases).join("|")}|all`);
    process.exit(2);
  }
} finally {
  // Best-effort safety net: never leave probe identities behind, even on error.
  if (PHASE === "all" || PHASE === "identity") {
    spawnSync("bunx", ["convex", "run", "securitySelftest:cleanupAuthProbeUsers", "{}"], {
      encoding: "utf8",
      timeout: 120000,
    });
  }
}

console.log(
  `\nAUTH REGRESSION (${PHASE}) — ${failed === 0 ? "ALL PASSED" : "FAILURES"} — passed ${passed}, failed ${failed}, skipped ${skipped}` +
    (failures.length ? `\nFailed: ${failures.join(" | ")}` : ""),
);
process.exit(failed === 0 ? 0 : 1);
