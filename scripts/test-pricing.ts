/**
 * Penroute pricing engine test suite — run with:  bun scripts/test-pricing.ts
 *
 * Covers the required boundary volumes (1, 50, 200, 201, 1,000, 1,001, 5,000,
 * 5,001, 10,000, 10,001), fee math, configurability (the engine must follow
 * whatever tiers it is given — never constants), default subscription plans,
 * scale scenarios and error handling.
 */
import {
  DEFAULT_PRICING_TIERS,
  DEFAULT_SUBSCRIPTION_PLANS,
  computeProcessingFee,
  revenueScenarios,
  selectTier,
  tierRangeLabel,
  type PricingTier,
} from "../src/lib/pricing";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`PASS  ${label}`);
  } else {
    failed++;
    console.error(`FAIL  ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
  }
}

function checkThrows(label: string, fn: () => unknown) {
  try {
    fn();
    failed++;
    console.error(`FAIL  ${label} — expected an error, none thrown`);
  } catch {
    passed++;
    console.log(`PASS  ${label}`);
  }
}

// ---------------------------------------------------------------- tier selection
const boundaries: [number, number][] = [
  // [postings, expected fee per posting in kobo]
  [1, 2000],
  [50, 2000],
  [200, 2000],
  [201, 1500],
  [1_000, 1500],
  [1_001, 1200],
  [5_000, 1200],
  [5_001, 1000],
  [10_000, 1000],
  [10_001, 800],
  [500_000, 800],
  [1_000_000, 800],
];
for (const [volume, rate] of boundaries) {
  check(
    `tier for ${volume.toLocaleString()} postings → ₦${rate / 100}/posting`,
    computeProcessingFee(DEFAULT_PRICING_TIERS, volume).feePerPostingKobo,
    rate,
  );
}

// ---------------------------------------------------------------- fee math
check(
  "200 postings × ₦20 = ₦400,000 (40000000 kobo)",
  computeProcessingFee(DEFAULT_PRICING_TIERS, 200).processingFeeKobo,
  200 * 2000,
);
check(
  "201 postings × ₦15 = ₦301,500 (30150000 kobo)",
  computeProcessingFee(DEFAULT_PRICING_TIERS, 201).processingFeeKobo,
  201 * 1500,
);
check(
  "10,001 postings × ₦8 = ₦80,008 (8000800 kobo)",
  computeProcessingFee(DEFAULT_PRICING_TIERS, 10_001).processingFeeKobo,
  10_001 * 800,
);
check(
  "1,000,000 postings × ₦8 = ₦8,000,000 (800000000 kobo)",
  computeProcessingFee(DEFAULT_PRICING_TIERS, 1_000_000).processingFeeKobo,
  1_000_000 * 800,
);

// ---------------------------------------------------------------- idempotency
const a = computeProcessingFee(DEFAULT_PRICING_TIERS, 750);
const b = computeProcessingFee(DEFAULT_PRICING_TIERS, 750);
check("quote is deterministic (same input → same snapshot)", a, b);

// ---------------------------------------------------------------- configurability
// The engine must follow WHATEVER tiers it is given — no constants baked in.
const customTiers: PricingTier[] = [
  { code: "only", label: "Everything", minEmployees: 1, maxEmployees: null, feePerPostingKobo: 555 },
];
check(
  "custom configured tier is respected (2,500 postings → 555 kobo)",
  computeProcessingFee(customTiers, 2_500).feePerPostingKobo,
  555,
);
const shifted: PricingTier[] = [
  { code: "small", label: "1–10", minEmployees: 1, maxEmployees: 10, feePerPostingKobo: 100 },
  { code: "big", label: "11+", minEmployees: 11, maxEmployees: null, feePerPostingKobo: 50 },
];
check("reconfigured boundaries respected (5 → 100 kobo)", computeProcessingFee(shifted, 5).feePerPostingKobo, 100);
check("reconfigured boundaries respected (11 → 50 kobo)", computeProcessingFee(shifted, 11).feePerPostingKobo, 50);

// Unsorted input must still resolve correctly.
const shuffled = [...DEFAULT_PRICING_TIERS].reverse();
check(
  "unsorted tier input resolves correctly (1,001 → 1200 kobo)",
  selectTier(shuffled, 1_001).feePerPostingKobo,
  1200,
);

// ---------------------------------------------------------------- defaults
check("default tier count", DEFAULT_PRICING_TIERS.length, 5);
check(
  "default tier ranges",
  DEFAULT_PRICING_TIERS.map((t) => tierRangeLabel(t.minEmployees, t.maxEmployees)),
  [
    "1–200 employees",
    "201–1,000 employees",
    "1,001–5,000 employees",
    "5,001–10,000 employees",
    "10,001+ employees",
  ],
);
check(
  "default subscription plans",
  DEFAULT_SUBSCRIPTION_PLANS.map((p) => [p.code, p.monthlyPriceKobo, p.priceIsFrom]),
  [
    ["starter", 1_000_000, false],
    ["business", 2_500_000, false],
    ["enterprise", 7_500_000, true],
  ],
);

// ---------------------------------------------------------------- scale scenarios
const scenarios = revenueScenarios(DEFAULT_PRICING_TIERS, [10_000, 50_000, 100_000, 500_000, 1_000_000]);
check(
  "scenario volumes sorted",
  scenarios.map((s) => s.postingVolume),
  [10_000, 50_000, 100_000, 500_000, 1_000_000],
);
check(
  "scenario rates use configured tiers (10k → ₦10, rest → ₦8)",
  scenarios.map((s) => s.feePerPostingKobo),
  [1000, 800, 800, 800, 800],
);
check(
  "1M/month processing revenue = 1,000,000 × ₦8",
  scenarios[4].monthlyProcessingRevenueKobo,
  1_000_000 * 800,
);
check(
  "annualised = monthly × 12",
  scenarios[4].annualProcessingRevenueKobo,
  1_000_000 * 800 * 12,
);

// ---------------------------------------------------------------- error handling
checkThrows("negative posting volume rejected", () => selectTier(DEFAULT_PRICING_TIERS, -1));
checkThrows("empty tier table rejected", () => selectTier([], 10));

// ---------------------------------------------------------------- report
const time = new Date();
console.log(
  `\n${failed === 0 ? "ALL TESTS PASSED" : `${failed} TEST(S) FAILED`} — ${passed} passed, ${failed} failed — ${time.toISOString()} (local ${time.toString()})`,
);
process.exit(failed === 0 ? 0 : 1);
