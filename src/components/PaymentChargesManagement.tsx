import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { friendlyError } from "@/lib/errors";
import { describeCharge, type PaymentChargeConfig } from "@/lib/paymentCharges";
import { CreditCard } from "lucide-react";
import { toast } from "sonner";

/**
 * Payment processing charges passed to the employer by payment method (card
 * fee, optional bank-transfer fee). Read-only with "Change charges"; the
 * super admin saves directly, any other admin submits for approval.
 */
type Form = {
  enabled: boolean;
  cardPct: string;
  cardFlat: string;
  cardWaiver: string;
  cardCap: string;
  bankPct: string;
  bankFlat: string;
  bankCap: string;
};

const toForm = (c: PaymentChargeConfig): Form => ({
  enabled: c.enabled,
  cardPct: String(c.cardBps / 100),
  cardFlat: String(c.cardFlatKobo / 100),
  cardWaiver: String(c.cardFlatWaiverBelowKobo / 100),
  cardCap: String(c.cardCapKobo / 100),
  bankPct: String(c.bankBps / 100),
  bankFlat: String(c.bankFlatKobo / 100),
  bankCap: String(c.bankCapKobo / 100),
});

function parse(f: Form): PaymentChargeConfig | string {
  const num = (s: string) => Number(s.replace(/[₦,%\s]/g, "") || "0");
  const vals = [f.cardPct, f.cardFlat, f.cardWaiver, f.cardCap, f.bankPct, f.bankFlat, f.bankCap].map(num);
  if (vals.some((n) => !Number.isFinite(n) || n < 0)) return "Enter numbers only (0 or more)";
  const [cardPct, cardFlat, cardWaiver, cardCap, bankPct, bankFlat, bankCap] = vals;
  return {
    enabled: f.enabled,
    cardBps: Math.round(cardPct * 100),
    cardFlatKobo: Math.round(cardFlat * 100),
    cardFlatWaiverBelowKobo: Math.round(cardWaiver * 100),
    cardCapKobo: Math.round(cardCap * 100),
    bankBps: Math.round(bankPct * 100),
    bankFlatKobo: Math.round(bankFlat * 100),
    bankCapKobo: Math.round(bankCap * 100),
  };
}

function Field({ id, label, value, onChange, suffix }: { id: string; label: string; value: string; onChange: (v: string) => void; suffix: "%" | "₦" }) {
  return (
    <div className="w-36">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <div className="relative mt-1">
        {suffix === "₦" && (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">₦</span>
        )}
        <Input id={id} inputMode="decimal" className={suffix === "₦" ? "pl-7" : "pr-7"} value={value} onChange={(e) => onChange(e.target.value)} />
        {suffix === "%" && (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
        )}
      </div>
    </div>
  );
}

export function PaymentChargesManagement() {
  const current = useQuery(api.paymentCharges.getPaymentCharges);
  const requests = useQuery(api.approvals.listPricingRequests);
  const save = useMutation(api.paymentCharges.updatePaymentCharges);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = requests?.pending.find((r) => r.kind === "paymentCharges");
  const isSuper = Boolean(requests?.isSuperAdmin);
  const set = (k: keyof Form) => (v: string) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const submit = async () => {
    if (!form) return;
    const parsed = parse(form);
    if (typeof parsed === "string") {
      toast.error(parsed);
      return;
    }
    setBusy(true);
    try {
      const res = await save(parsed);
      toast.success("pending" in res ? "Change submitted for approval" : "Payment charges updated");
      setForm(null);
    } catch (e) {
      toast.error(friendlyError(e, "Update failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pen-card-lg p-6">
      <h2 className="flex items-center gap-2 font-bold tracking-tight">
        <CreditCard className="size-5 text-primary" /> Payment processing charges
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The payment gateway's fee is passed to the employer who chooses that method, shown as its own
        line before they pay. It covers the gateway — it is not Penroute revenue. Applies when
        Penroute collects payments directly (not on the approved-provider route).
      </p>
      {!form ? (
        <div className="mt-4 flex flex-wrap items-center gap-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Card</p>
            <p className="font-semibold">{current ? describeCharge(current, "card") : "—"}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Bank transfer / USSD</p>
            <p className="font-semibold">{current ? describeCharge(current, "bank") : "—"}</p>
          </div>
          <Button variant="outline" className="font-semibold" disabled={!current || Boolean(pending)} onClick={() => current && setForm(toForm(current))}>
            Change charges
          </Button>
          {pending && <p className="w-full text-sm text-[#7A5A10]">Awaiting approval: {pending.summary}</p>}
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" className="size-4 accent-[#007A4D]" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            Pass processing charges to employers
          </label>
          <div>
            <p className="text-sm font-semibold">Card</p>
            <div className="mt-1 flex flex-wrap gap-3">
              <Field id="c-pct" label="Percentage" value={form.cardPct} onChange={set("cardPct")} suffix="%" />
              <Field id="c-flat" label="Plus flat amount" value={form.cardFlat} onChange={set("cardFlat")} suffix="₦" />
              <Field id="c-waive" label="Flat waived below" value={form.cardWaiver} onChange={set("cardWaiver")} suffix="₦" />
              <Field id="c-cap" label="Maximum (0 = none)" value={form.cardCap} onChange={set("cardCap")} suffix="₦" />
            </div>
          </div>
          <div>
            <p className="text-sm font-semibold">Bank transfer / USSD</p>
            <div className="mt-1 flex flex-wrap gap-3">
              <Field id="b-pct" label="Percentage" value={form.bankPct} onChange={set("bankPct")} suffix="%" />
              <Field id="b-flat" label="Plus flat amount" value={form.bankFlat} onChange={set("bankFlat")} suffix="₦" />
              <Field id="b-cap" label="Maximum (0 = none)" value={form.bankCap} onChange={set("bankCap")} suffix="₦" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Check your Paystack dashboard for your current rates. Paystack's standard Nigerian card
            pricing is 1.5% + ₦100 (₦100 waived under ₦2,500), capped at ₦2,000.
          </p>
          <div className="flex gap-2">
            <Button className="font-semibold" disabled={busy} onClick={() => void submit()}>
              {isSuper ? "Save charges" : "Submit for approval"}
            </Button>
            <Button variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
