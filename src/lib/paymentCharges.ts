/**
 * PAYMENT PROCESSING CHARGES — the gateway's fee (e.g. Paystack's card fee)
 * passed on to the employer who chooses that payment method. It is a
 * pass-through to cover the processor, NOT Penroute revenue and NOT a pension
 * contribution. Shared by the server (authoritative) and the browser (preview)
 * so the employer sees exactly what will be charged.
 */

export type PayMethod = "bank" | "card";

export interface PaymentChargeConfig {
  /** Master switch: off → nobody is charged a processing fee. */
  enabled: boolean;
  /** Card: percentage in basis points (150 = 1.5%). */
  cardBps: number;
  /** Card: flat amount added (kobo). */
  cardFlatKobo: number;
  /** Card: the flat amount is waived below this payment size (kobo). */
  cardFlatWaiverBelowKobo: number;
  /** Card: maximum charge (kobo). 0 = no cap. */
  cardCapKobo: number;
  /** Bank transfer / USSD: same three settings. */
  bankBps: number;
  bankFlatKobo: number;
  bankCapKobo: number;
}

/** Defaults mirror Paystack's published local card pricing (1.5% + ₦100,
 *  ₦100 waived under ₦2,500, capped at ₦2,000). Bank transfer defaults to
 *  free. The super admin can change every value. */
export const DEFAULT_PAYMENT_CHARGES: PaymentChargeConfig = {
  enabled: true,
  cardBps: 150,
  cardFlatKobo: 10_000,
  cardFlatWaiverBelowKobo: 250_000,
  cardCapKobo: 200_000,
  bankBps: 0,
  bankFlatKobo: 0,
  bankCapKobo: 0,
};

export const PAYMENT_CHARGE_LIMITS = {
  maxBps: 1_000, // 10%
  maxFlatKobo: 1_000_000, // ₦10,000
  maxCapKobo: 10_000_000, // ₦100,000
  maxWaiverKobo: 100_000_000, // ₦1,000,000
};

/** Processing charge (kobo) for paying `baseKobo` (pension + Penroute fee). */
export function processingChargeKobo(baseKobo: number, method: PayMethod, cfg: PaymentChargeConfig): number {
  if (!cfg.enabled || baseKobo <= 0) return 0;
  const bps = method === "card" ? cfg.cardBps : cfg.bankBps;
  const flat = method === "card" ? (baseKobo < cfg.cardFlatWaiverBelowKobo ? 0 : cfg.cardFlatKobo) : cfg.bankFlatKobo;
  const cap = method === "card" ? cfg.cardCapKobo : cfg.bankCapKobo;
  const raw = Math.ceil((baseKobo * bps) / 10_000) + flat;
  return Math.max(0, cap > 0 ? Math.min(raw, cap) : raw);
}

/** Validation shared by the server mutation (throws a message on failure). */
export function validatePaymentCharges(c: PaymentChargeConfig): string | null {
  const ints = [c.cardBps, c.cardFlatKobo, c.cardFlatWaiverBelowKobo, c.cardCapKobo, c.bankBps, c.bankFlatKobo, c.bankCapKobo];
  if (ints.some((n) => !Number.isInteger(n) || n < 0)) return "Charges must be whole, non-negative amounts";
  const L = PAYMENT_CHARGE_LIMITS;
  if (c.cardBps > L.maxBps || c.bankBps > L.maxBps) return "Percentage cannot exceed 10%";
  if (c.cardFlatKobo > L.maxFlatKobo || c.bankFlatKobo > L.maxFlatKobo) return "Flat amount cannot exceed ₦10,000";
  if (c.cardCapKobo > L.maxCapKobo || c.bankCapKobo > L.maxCapKobo) return "Cap cannot exceed ₦100,000";
  if (c.cardFlatWaiverBelowKobo > L.maxWaiverKobo) return "Waiver threshold cannot exceed ₦1,000,000";
  return null;
}

/** Plain-language description, e.g. "1.5% + ₦100 (₦100 waived under ₦2,500), max ₦2,000". */
export function describeCharge(c: PaymentChargeConfig, method: PayMethod): string {
  if (!c.enabled) return "No charge";
  const n = (k: number) => `₦${(k / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;
  const bps = method === "card" ? c.cardBps : c.bankBps;
  const flat = method === "card" ? c.cardFlatKobo : c.bankFlatKobo;
  const cap = method === "card" ? c.cardCapKobo : c.bankCapKobo;
  if (bps === 0 && flat === 0) return "Free";
  const parts: string[] = [];
  if (bps > 0) parts.push(`${(bps / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 })}%`);
  if (flat > 0) {
    parts.push(
      method === "card" && c.cardFlatWaiverBelowKobo > 0
        ? `${n(flat)} (waived under ${n(c.cardFlatWaiverBelowKobo)})`
        : n(flat),
    );
  }
  return `${parts.join(" + ")}${cap > 0 ? `, max ${n(cap)}` : ""}`;
}
