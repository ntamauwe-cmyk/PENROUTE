/**
 * ============================================================================
 * PENROUTE PRICING ENGINE — the ONE source of truth for pricing.
 * ----------------------------------------------------------------------------
 * Every fee, rate, tier and subscription price used anywhere in Penroute is
 * derived from this module (defaults) or from the administrator-managed
 * `pricingTiers` / `subscriptionPlans` tables (live configuration). Values are
 * NEVER hard-coded in screens or components — components receive computed
 * quotes from the backend, which calls into this engine.
 *
 * Money is expressed in KOBO (₦1 = 100 kobo) everywhere, matching the rest of
 * the Penroute data model.
 *
 * Tier basis: an employer's employee posting volume (the number of billable
 * pension contribution postings in a posting run) selects the applicable tier.
 * The backend snapshots the selected rate into each billing record at the
 * moment a transaction is quoted, so later pricing changes never rewrite
 * history.
 * ============================================================================
 */

export type PricingTier = {
  code: string;
  label: string;
  minEmployees: number;
  /** null = open-ended upper bound (e.g. 10,001+). */
  maxEmployees: number | null;
  feePerPostingKobo: number;
};

export type SubscriptionPlan = {
  code: string;
  name: string;
  monthlyPriceKobo: number;
  /** true when the price is a floor ("From ₦75,000/month"). */
  priceIsFrom: boolean;
  description: string;
};

/**
 * Default processing-fee tiers (used only to seed the database — after
 * seeding, administrators manage live values through the pricing console).
 *  1–200    → ₦20 per posting
 *  201–1,000 → ₦15 per posting
 *  1,001–5,000 → ₦12 per posting
 *  5,001–10,000 → ₦10 per posting
 *  10,001+  → ₦8 per posting
 */
export const DEFAULT_PRICING_TIERS: PricingTier[] = [
  { code: "tier-1", label: "1–200 employees", minEmployees: 1, maxEmployees: 200, feePerPostingKobo: 2000 },
  { code: "tier-2", label: "201–1,000 employees", minEmployees: 201, maxEmployees: 1000, feePerPostingKobo: 1500 },
  { code: "tier-3", label: "1,001–5,000 employees", minEmployees: 1001, maxEmployees: 5000, feePerPostingKobo: 1200 },
  { code: "tier-4", label: "5,001–10,000 employees", minEmployees: 5001, maxEmployees: 10000, feePerPostingKobo: 1000 },
  { code: "tier-5", label: "10,001+ employees", minEmployees: 10001, maxEmployees: null, feePerPostingKobo: 800 },
];

/** Default (optional) employer platform subscription plans. */
export const DEFAULT_SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  {
    code: "starter",
    name: "Starter",
    monthlyPriceKobo: 10_000 * 100,
    priceIsFrom: false,
    description: "Core platform access for small employers.",
  },
  {
    code: "business",
    name: "Business",
    monthlyPriceKobo: 25_000 * 100,
    priceIsFrom: false,
    description: "Advanced reporting and integrations for growing employers.",
  },
  {
    code: "enterprise",
    name: "Enterprise",
    monthlyPriceKobo: 75_000 * 100,
    priceIsFrom: true,
    description: "From ₦75,000/month — dedicated support and custom integrations.",
  },
];

export type TierQuote = {
  tier: PricingTier;
  feePerPostingKobo: number;
  postingCount: number;
  processingFeeKobo: number;
};

/**
 * Select the applicable tier for a posting volume from a set of tiers.
 * Tiers may arrive in any order; overlapping ranges are rejected upstream by
 * the admin validation, and the smallest matching minimum wins defensively.
 */
export function selectTier(tiers: PricingTier[], postingVolume: number): PricingTier {
  if (!Number.isFinite(postingVolume) || postingVolume < 0) {
    throw new Error(`Invalid posting volume: ${postingVolume}`);
  }
  const volume = Math.max(1, Math.floor(postingVolume));
  const sorted = [...tiers].sort((a, b) => a.minEmployees - b.minEmployees);
  const match = sorted.find(
    (t) => volume >= t.minEmployees && (t.maxEmployees === null || volume <= t.maxEmployees),
  );
  if (match) return match;
  // Below the lowest configured tier → cheapest-volume tier still applies.
  if (sorted.length > 0 && volume < sorted[0].minEmployees) return sorted[0];
  throw new Error(`No pricing tier covers a posting volume of ${volume}`);
}

/** Compute the Penroute processing fee for a posting volume. */
export function computeProcessingFee(tiers: PricingTier[], postingVolume: number): TierQuote {
  const tier = selectTier(tiers, postingVolume);
  const count = Math.max(0, Math.floor(postingVolume));
  return {
    tier,
    feePerPostingKobo: tier.feePerPostingKobo,
    postingCount: count,
    processingFeeKobo: count * tier.feePerPostingKobo,
  };
}

/** True when `volume` falls inside the tier's [min, max] range. */
export function tierCovers(tier: PricingTier, volume: number): boolean {
  return volume >= tier.minEmployees && (tier.maxEmployees === null || volume <= tier.maxEmployees);
}

/** Human label for a tier range (used when an admin creates a tier). */
export function tierRangeLabel(minEmployees: number, maxEmployees: number | null): string {
  return maxEmployees === null
    ? `${minEmployees.toLocaleString()}+ employees`
    : `${minEmployees.toLocaleString()}–${maxEmployees.toLocaleString()} employees`;
}

/** Revenue scenario row for administrator analytics (revenue, NOT profit). */
export type RevenueScenario = {
  postingVolume: number;
  tierCode: string;
  tierLabel: string;
  feePerPostingKobo: number;
  monthlyProcessingRevenueKobo: number;
  annualProcessingRevenueKobo: number;
};

/**
 * Project gross processing-fee revenue for posting-volume scenarios USING THE
 * ACTUALLY CONFIGURED TIERS — never hard-coded rates. One month of postings
 * at the given volume; annualised × 12.
 */
export function revenueScenarios(tiers: PricingTier[], volumes: number[]): RevenueScenario[] {
  return volumes
    .slice()
    .sort((a, b) => a - b)
    .map((volume) => {
      const quote = computeProcessingFee(tiers, volume);
      return {
        postingVolume: volume,
        tierCode: quote.tier.code,
        tierLabel: quote.tier.label,
        feePerPostingKobo: quote.feePerPostingKobo,
        monthlyProcessingRevenueKobo: quote.processingFeeKobo,
        annualProcessingRevenueKobo: quote.processingFeeKobo * 12,
      };
    });
}

/** Default scenario volumes for the revenue analytics view. */
export const DEFAULT_SCENARIO_VOLUMES = [10_000, 50_000, 100_000, 500_000, 1_000_000];
