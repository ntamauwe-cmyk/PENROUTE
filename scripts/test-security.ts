/**
 * SECURITY REGRESSION TESTS — run: bun scripts/test-security.ts
 *
 * Two layers:
 *  1. Unit tests of the shared security primitives (src/lib/security.ts) —
 *     the exact functions the Convex backend uses in production.
 *  2. Static invariants over the source tree: security-critical properties
 *     that must never regress (function visibility, auth gates, secret
 *     stripping, webhook checks, SSRF controls, CSPRNG references).
 *
 * Exit code 0 = all checks passed.
 */
import { readFileSync } from "node:fs";
import {
  hashApiKey,
  isSafePublicHttpsUrl,
  randRef,
  readCapped,
} from "../src/lib/security";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`PASS  ${label}`);
  } else {
    failed++;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function checkEq(label: string, actual: unknown, expected: unknown) {
  check(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

const read = (p: string) => readFileSync(p, "utf8");

// ===========================================================================
// 1. SSRF guard (PFA outbound endpoint validation)
// ===========================================================================
const ALLOW = [
  "https://api.example.com",
  "https://sub.domain.pfa.org.ng",
  "https://example.com:443/path?x=1",
  "https://172.15.31.1", // just outside RFC1918 172.16/12
  "https://172.32.0.1", // just outside RFC1918 172.16/12
  "https://100.63.255.255", // just outside CGNAT 100.64/10
  "https://203.0.113.10",
];
const DENY = [
  "",
  "not a url",
  "http://api.example.com", // must be https
  "ftp://api.example.com",
  "https://localhost",
  "https://localhost:8443",
  "https://app.local",
  "https://metadata.google.internal",
  "https://instance-data",
  "https://127.0.0.1",
  "https://10.0.0.5",
  "https://172.16.0.1",
  "https://172.31.255.255",
  "https://192.168.1.1",
  "https://192.0.0.1",
  "https://169.254.169.254", // cloud metadata
  "https://100.64.0.1", // CGNAT
  "https://224.0.0.1", // multicast
  "https://0.0.0.0",
  "https://[::1]",
  "https://[fd00::1]",
  "https://198.18.0.1", // benchmark range
  "https://user:pass@api.example.com", // credentials in URL
  "https://api.example.com:8443", // non-443 port
  "https://intranet", // bare single-label host
  "https://example.com.", // trailing-dot bypass
];
for (const url of ALLOW) {
  check(`SSRF allows public https URL: ${url || "(empty)"}`, isSafePublicHttpsUrl(url));
}
for (const url of DENY) {
  check(`SSRF blocks unsafe target: ${url || "(empty)"}`, !isSafePublicHttpsUrl(url));
}

// ===========================================================================
// 2. CSPRNG reference generation
// ===========================================================================
{
  const sample = randRef("PMT", 8);
  check(
    `randRef keeps legacy format (PMT-XXXXXXXX): ${sample}`,
    /^PMT-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(sample),
  );
  const empty = randRef("", 6);
  check(
    `randRef keeps legacy empty-prefix format: ${empty}`,
    /^-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(empty),
  );
  const seen = new Set<string>();
  let unique = true;
  for (let i = 0; i < 500; i++) {
    const r = randRef("TST", 6);
    if (seen.has(r)) unique = false;
    seen.add(r);
  }
  check("randRef: 500 references are unique", unique);
  const chars = new Set(randRef("X", 400).replace(/-/g, "").replace(/X/g, ""));
  check(
    "randRef: alphabet excludes ambiguous characters (I, L, O, 0, 1)",
    !chars.has("I") && !chars.has("L") && !chars.has("O"),
  );
}

// ===========================================================================
// 3. API-key hashing
// ===========================================================================
{
  const key = "penr_live_0123456789abcdef0123456789abcdef0123456789abcdef";
  const h1 = await hashApiKey(key);
  const h2 = await hashApiKey(key);
  const other = await hashApiKey(key + "x");
  checkEq("hashApiKey is deterministic (64-hex)", [h1, h2], [h1, h1]);
  check("hashApiKey returns 64 hex chars", /^[0-9a-f]{64}$/.test(h1));
  check("hashApiKey differs for different keys", h1 !== other);
  check("hashApiKey does not contain the raw key", !h1.includes(key));
}

// ===========================================================================
// 4. Bounded body reads (request/response size caps)
// ===========================================================================
{
  const okBody = "x".repeat(1000);
  const ok = await readCapped(new Response(okBody).body, 2000);
  checkEq("readCapped passes bodies under the cap", ok, okBody);
  let threw = false;
  try {
    await readCapped(new Response("y".repeat(5000)).body, 2000);
  } catch {
    threw = true;
  }
  check("readCapped throws once the cap is exceeded", threw);
}

// ===========================================================================
// 5. Static source invariants
// ===========================================================================
const engine = read("src/convex/engine.ts");
const pension = read("src/convex/pension.ts");
const payments = read("src/convex/payments.ts");
const webhook = read("src/convex/paystackWebhook.ts");
const pfaDispatch = read("src/convex/pfaDispatch.ts");
const payrollApi = read("src/convex/payrollApi.ts");
const contributions = read("src/convex/contributions.ts");
const employersSrc = read("src/convex/employers.ts");
const schema = read("src/convex/schema.ts");
const adapters = read("src/convex/adapters.ts");
const ghSync = read("src/convex/githubSync.ts");
const ghSyncData = read("src/convex/githubSyncData.ts");
const wizard = read("src/components/LivePaymentPanel.tsx");
const settings = read("src/pages/employer/Settings.tsx");

// --- payment state machine stays server-side -------------------------------
check("engine: processPipeline is internal (not client-callable)", engine.includes("export const processPipeline = internalMutation"));
check("engine: finalizeLivePayment is internal", engine.includes("export const finalizeLivePayment = internalMutation"));
check("engine: finalizeLivePaymentSystem is internal", engine.includes("export const finalizeLivePaymentSystem = internalMutation"));
check("engine: intakeApiSchedule (payroll API) is internal", engine.includes("export const intakeApiSchedule = internalMutation"));
check("engine: authenticated resumePipeline exists for the UI", engine.includes("export const resumePipeline = mutation"));
check("engine: resumePipeline enforces ownership before scheduling", /resumePipeline[\s\S]*?batch\.employerId !== employer\._id/.test(engine));
check("payment panel: browser only calls confirmLivePayment (server verifies)", wizard.includes("confirmLivePayment") && !wizard.includes("finalizeLivePayment") && !wizard.includes("api.payments.verifyLivePayment"));
check("payments: confirmLivePayment re-verifies exact amount/currency/reference", payments.includes("verified.amountKobo !== payment.amount") && payments.includes('verified.currency !== "NGN"'));
check("payments: initializeLivePayment requires a matching stored pending payment", payments.includes("No matching authorized pending payment"));

// --- webhook integrity ------------------------------------------------------
check("webhook: signature verified with timing-safe compare", webhook.includes("timingSafeEqualHex") && webhook.includes("SHA-512"));
check("webhook: no in-memory-only idempotency (durable status guards)", !webhook.includes("processedEvents"));
check("webhook: rejects status/amount/currency mismatches exactly", webhook.includes("event.data?.amount !== payment.amount") && webhook.includes('event.data?.currency !== "NGN"'));
check("webhook: body read is size-capped", webhook.includes("readCapped"));

// --- employer approval / demo gating ---------------------------------------
check("engine: prepareBatch requires approved employer", engine.includes('employer.status !== "active" || employer.kycStatus !== "verified"'));
check("engine: payroll intake requires approved employer", engine.includes('"Employer account is not approved for contribution intake"'));
check("pension: new self-service employers start pending", pension.includes('status: "pending"') && pension.includes('kycStatus: "pending"'));
check("pension: demo seeding restricted to admins", pension.includes("Demo data seeding is restricted to platform admins"));
check("pension: demo employer claim restricted to admins", pension.includes("Demo employer claiming is restricted to platform admins"));
check("pension: dashboard resolves employer via strict membership helper", pension.includes("Explicit employer membership only"));

// --- tenant isolation / secret stripping ------------------------------------
check("employers: no demo-employer fallback in resolution", employersSrc.includes("Never fall back to a shared active/demo employer"));
check("contributions: employer payload strips API key", contributions.includes("employer: safeEmployer(employer)"));
check("pension: dashboard strips API key and hash", pension.includes("apiKey: undefined, apiKeyHash: undefined"));
check("schema: payroll keys stored hashed (by_apiKeyHash index)", schema.includes('index("by_apiKeyHash"') && schema.includes("apiKeyHash: v.optional"));
check("employers: generateApiKey stores only the hash", employersSrc.includes("apiKeyHash: await hashApiKey(key)") && employersSrc.includes("apiKey: undefined"));
check("employers: revocation clears both copies", employersSrc.includes("apiKeyHash: undefined"));
check("engine: intake verifies via hash index with legacy upgrade", engine.includes('withIndex("by_apiKeyHash"') && engine.includes("hashApiKey(apiKey)"));
check("engine: intake has durable per-employer rate limit", engine.includes("Too many intake requests") && engine.includes("intakeWindowStart"));
check("engine: batch/payment references get DB uniqueness retries", engine.includes('withIndex("by_ref", (q) => q.eq("batchRef", batchRef))') && engine.includes('withIndex("by_ref", (q) => q.eq("paymentRef", paymentRef))'));

// --- PFA outbound hardening -------------------------------------------------
check("pfaDispatch: dispatch is internal (server-scheduled only)", pfaDispatch.includes("export const dispatchLiveSettlements = internalAction"));
check("pfaDispatch: connection test requires admin", pfaDispatch.includes("Admin access required"));
check("pfaDispatch: SSRF allow-list imported from shared tested helper", pfaDispatch.includes('from "../lib/security"') && pfaDispatch.includes("isSafePublicHttpsUrl"));
check("pfaDispatch: redirects cannot bypass the allow-list", pfaDispatch.includes('redirect: "error"'));
check("pfaDispatch: outbound requests time out", pfaDispatch.includes("AbortSignal.timeout"));
check("pfaDispatch: responses are size-capped", pfaDispatch.includes("readCapped"));
check("pension: PFA allocations strip endpointConfig", pension.includes("delete safePfa.endpointConfig"));
check("pension: PFA list strips endpointConfig", pension.includes("delete safe.endpointConfig"));

check("pension: resolveException enforces employer ownership", pension.includes("mine._id !== exc.employerId"));
check("pension: fee changes require admin", pension.includes("Only platform admins can change pricing"));

// --- audit / integration log integrity --------------------------------------
check("pension: internalAudit is internal (no public forging)", pension.includes("export const internalAudit = internalMutation"));
check("adapters: testAdapters requires admin (integration log not forgeable)", adapters.includes("Admin access required"));

// --- GitHub sync privilege ---------------------------------------------------
check("githubSync: pushToGitHub requires an admin caller", ghSync.includes("requireAdminCaller(ctx)"));
check("githubSync: internal CLI path exists for audited operator pushes", ghSync.includes("export const internalPushToGitHub = internalAction"));
check("githubSyncData: stagePush requires an admin caller", ghSyncData.includes("await requireAdminUser(ctx)"));
check("githubSyncData: internal CLI staging path exists", ghSyncData.includes("export const internalStagePush = internalMutation"));
check("githubSyncData: push status query is admin-gated", ghSyncData.includes("Status of a staged push") && ghSyncData.includes("requireAdminUser(ctx)"));
check("Settings: GitHub sync card hidden from non-admins", settings.includes('if (me?.role !== "admin") return null;') && settings.includes('"skip"'));

// --- payroll API request limits ---------------------------------------------
check("payrollApi: request body size cap", payrollApi.includes("readCapped(request.body, 2_000_000)"));
check("payrollApi: row-count limit", payrollApi.includes("10_000"));
check("engine: schedule row limit enforced on both doors", engine.includes("maximum 10,000 records per submission"));

// --- CSPRNG everywhere in the backend ---------------------------------------
{
  const convexFiles = [
    "src/convex/admin.ts",
    "src/convex/billing.ts",
    "src/convex/engine.ts",
    "src/convex/pfaDispatchData.ts",
    "src/convex/pricing.ts",
    "src/convex/employers.ts",
    "src/convex/pension.ts",
  ];
  const offenders = convexFiles.filter((f) => read(f).includes("Math.random"));
  check("backend: no Math.random in reference-generating modules", offenders.length === 0, offenders.join(", "));
}

// --- repository hygiene ------------------------------------------------------
{
  const manifest = read("src/lib/github-manifest.generated.ts");
  const paths = [...manifest.matchAll(/path: "([^"]+)"/g)].map((m) => m[1]);
  const envFiles = paths.filter((p) => p.startsWith(".env"));
  check(
    "manifest: no env files staged for GitHub (only .env.example allowed)",
    envFiles.every((p) => p === ".env.example"),
    envFiles.join(", "),
  );
  const secretRes = [
    /sk_live_[A-Za-z0-9]{16,}/,
    /sk_test_[A-Za-z0-9]{16,}/,
    /ghp_[A-Za-z0-9]{36,}/,
    /github_pat_[A-Za-z0-9_]{22,}/,
    /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /AKIA[0-9A-Z]{16}/,
  ];
  const hits: string[] = [];
  for (const f of ["src/convex/engine.ts", "src/convex/payments.ts", "src/convex/paystackWebhook.ts", "src/convex/githubSync.ts"]) {
    const text = read(f);
    for (const re of secretRes) if (re.test(text)) hits.push(`${f}:${re}`);
  }
  check("source: no provider credentials in payment/sync modules", hits.length === 0, hits.join(", "));
}

// ===========================================================================
console.log(
  `\n${failed === 0 ? "ALL SECURITY TESTS PASSED" : `${failed} SECURITY TEST(S) FAILED`} — ${passed} passed, ${failed} failed`,
);
process.exit(failed === 0 ? 0 : 1);
