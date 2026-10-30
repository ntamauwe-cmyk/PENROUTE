import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtDate, fmtNaira } from "@/lib/pension";
import { CheckCircle2, ClipboardCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";

/**
 * Settlements awaiting PFA confirmation (PFAs without a live API integration).
 * A settlement is only marked settled/posted when an authorised PFA operator
 * (own PFA only) or a platform admin records the PFA's posting reference.
 */
export function SettlementConfirmations({ scope }: { scope: "admin" | "pfa" }) {
  const rows = useQuery(api.settlementOps.listAwaitingConfirmation);
  const confirm = useMutation(api.settlementOps.confirmSettlement);
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const submit = async (id: Id<"settlements">) => {
    const reference = (refs[id] ?? "").trim();
    if (reference.length < 3) {
      toast.error("Enter the PFA posting or remittance reference");
      return;
    }
    setBusy(id);
    try {
      await confirm({ settlementId: id, reference });
      toast.success("Settlement confirmed — reconciliation will update automatically");
      setRefs((r) => ({ ...r, [id]: "" }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not confirm settlement");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="pen-card-lg p-6">
      <h2 className="flex items-center gap-2 font-bold tracking-tight">
        <ClipboardCheck className="size-5 text-primary" /> Settlements awaiting confirmation
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {scope === "pfa"
          ? "Confirm each remittance only after your organisation has received the funds and posted every employee's contribution. Quote your posting or remittance reference."
          : "For PFAs without a live API integration. Confirm only with the PFA's posting/remittance reference as evidence — nothing is reported as settled before this."}
      </p>

      {rows === undefined ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : rows.length === 0 ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-[#007A4D]" /> Nothing awaiting confirmation.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2">Settlement</th>
                {scope === "admin" && <th className="px-3 py-2">PFA</th>}
                <th className="px-3 py-2">Employer · period</th>
                <th className="px-3 py-2 text-right">Employees</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Posting reference</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r._id} className="border-t border-border/50 align-middle">
                  <td className="px-3 py-2.5">
                    <p className="font-mono text-xs">{r.settlementRef}</p>
                    <p className="text-xs text-muted-foreground">Instructed {fmtDate(r.instructedAt)}</p>
                  </td>
                  {scope === "admin" && <td className="px-3 py-2.5">{r.pfaName}</td>}
                  <td className="px-3 py-2.5">
                    <p>{r.employerName}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.batchRef} · {r.period}
                    </p>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{r.employeeCount}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtNaira(r.amount)}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label={`Posting reference for ${r.settlementRef}`}
                        className="h-8 w-44"
                        placeholder="e.g. PFA-POST-12345"
                        value={refs[r._id] ?? ""}
                        onChange={(e) => setRefs((m) => ({ ...m, [r._id]: e.target.value }))}
                      />
                      <Button size="sm" onClick={() => void submit(r._id)} disabled={busy === r._id}>
                        {busy === r._id ? <Loader2 className="size-4 animate-spin" /> : "Confirm"}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
