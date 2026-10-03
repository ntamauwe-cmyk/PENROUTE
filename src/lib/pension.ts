// Money, status-model and export helpers (spec §21, §18)

/** Format kobo (integer) as Nigerian Naira, e.g. 1250000 -> "₦12,500.00" */
export function fmtNaira(kobo: number, opts?: { compact?: boolean; noKobo?: boolean }): string {
  const n = kobo / 100;
  if (opts?.compact && Math.abs(n) >= 1_000_000) {
    return `₦${(n / 1_000_000).toFixed(1)}M`;
  }
  if (opts?.compact && Math.abs(n) >= 1_000) {
    return `₦${(n / 1_000).toFixed(1)}K`;
  }
  return n.toLocaleString("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: opts?.noKobo ? 0 : 2,
    maximumFractionDigits: opts?.noKobo ? 0 : 2,
  });
}

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export function monthName(month: number): string {
  return MONTHS[month - 1] ?? `M${month}`;
}

export function fmtDate(ts: number | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" });
}

export function fmtDateTime(ts: number | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-NG", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Status model — the platform distinguishes each pipeline stage (spec §21).
// Never display a contribution as "posted" until the PFA confirms it.
// ---------------------------------------------------------------------------

export type StatusTone = "green" | "blue" | "violet" | "amber" | "red" | "slate";

const TONES: Record<string, StatusTone> = {
  // batch status
  draft: "slate", awaiting_payment: "amber", processing: "blue", completed: "green", failed: "red",
  // payment
  pending: "slate", initiated: "blue", successful: "green", reversed: "amber",
  // allocation
  validating: "blue", allocated: "green", allocation_failed: "red", partially_allocated: "amber",
  // settlement
  settled: "green", partially_settled: "amber",
  // pfa
  awaiting_ack: "amber", received: "blue", accepted: "blue", posted: "violet", rejected: "red",
  reconciliation_pending: "amber", reconciled: "green",
  // reconciliation
  reconciled_recon: "green", exception: "red",
  // validation
  valid: "green", invalid: "red",
};

export function statusTone(status: string): StatusTone {
  return TONES[status] ?? "slate";
}

const LABELS: Record<string, string> = {
  awaiting_payment: "Awaiting payment",
  awaiting_ack: "Awaiting PFA ack",
  partially_settled: "Partially settled",
  partially_allocated: "Partially allocated",
};

export function statusLabel(status: string): string {
  return LABELS[status] ?? status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The employer's monthly pension cycle (spec §5, §41). */
export const CYCLE_STAGES = [
  "Prepare", "Validate", "Review", "Pay", "Process", "Allocate", "Settle", "Reconcile", "Complete",
] as const;

export function cycleStageIndex(batch: {
  status: string;
  paymentStatus: string;
  allocationStatus: string;
  settlementStatus: string;
  pfaStatus: string;
  reconciliationStatus: string;
}): number {
  if (batch.status === "completed") return CYCLE_STAGES.length - 1;
  if (batch.status === "processing") {
    if (batch.reconciliationStatus === "reconciled") return 8;
    if (batch.pfaStatus === "posted" || batch.pfaStatus === "reconciled") return 6;
    if (batch.settlementStatus === "settled") return 6;
    if (batch.allocationStatus === "allocated") return 5;
    return 4;
  }
  return 0; // awaiting payment
}

// ---------------------------------------------------------------------------
// CSV export (audit-ready; spec §18, §43)
// ---------------------------------------------------------------------------

export function downloadCsv(filename: string, rows: (string | number)[][]) {
  const escape = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(escape).join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Short system-generated verification hash for the certificate (spec §42). */
export function verificationCode(...parts: (string | number | undefined)[]): string {
  const s = parts.filter((p) => p !== undefined).join("|");
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + s.charCodeAt(i) * (i + 7), 0x85ebca6b) >>> 0;
  }
  return `VRF-${h1.toString(16).toUpperCase().padStart(8, "0")}-${h2.toString(16).toUpperCase().padStart(8, "0")}`;
}

/** Time-of-day greeting from the viewer's local clock.
 *  00–04 → evening, 05–11 → morning, 12–16 → afternoon, 17–23 → evening. */
export function greetingNow(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good evening";
}
