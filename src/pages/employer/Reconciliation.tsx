import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { DashboardShell } from "@/components/DashboardShell";
import { ClayTable, LoadingBlock, PageHeader, StatusPill, useEmployer } from "@/components/pension-ui";
import { fmtNaira } from "@/lib/pension";
import { CheckCircle2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

export default function Reconciliation() {
  const exceptions = useQuery(api.pension.listEmployerExceptions);
  const { batches } = useEmployer();
  const resolve = useMutation(api.pension.resolveException);
  const [resolving, setResolving] = useState<any>(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const open = (exceptions ?? []).filter((e: any) => e.status !== "resolved");
  const resolved = (exceptions ?? []).filter((e: any) => e.status === "resolved");

  const handleResolve = async () => {
    if (!resolving) return;
    setSaving(true);
    try {
      await resolve({ exceptionId: resolving._id, notes: notes.trim() || "Resolved by employer" });
      toast.success("Exception resolved");
      setResolving(null);
      setNotes("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not resolve exception");
    } finally {
      setSaving(false);
    }
  };

  return (
    <DashboardShell>
      <PageHeader
        title="Reconciliation"
        description="Financial integrity — every payment is verified against the schedule, settlements and PFA confirmations."
      />

      {/* Batch reconciliation status */}
      <section>
        <h2 className="mb-3 text-sm font-bold tracking-tight">Batch reconciliation</h2>
        <ClayTable
          headers={["Batch", "Period", "Pension", "Reconciliation", "Batch status"]}
          isEmpty={batches.length === 0}
          emptyMessage="No batches to reconcile yet."
        >
          {batches.map((b: any) => (
            <tr key={b._id} className="border-t border-border/50">
              <td className="px-3 py-2.5 font-mono text-xs font-medium">{b.batchRef}</td>
              <td className="px-3 py-2.5">{b.contributionMonth}/{b.contributionYear}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{fmtNaira(b.totalPensionAmount)}</td>
              <td className="px-3 py-2.5">
                <StatusPill status={b.reconciliationStatus} />
              </td>
              <td className="px-3 py-2.5">
                <StatusPill status={b.status} />
              </td>
            </tr>
          ))}
        </ClayTable>
      </section>

      {/* Exceptions */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold tracking-tight">
          <ShieldAlert className="size-4 text-[#D4AF37]" /> Exceptions
          {open.length > 0 && <Badge variant="secondary">{open.length} open</Badge>}
        </h2>
        {!exceptions ? (
          <LoadingBlock label="Loading exceptions…" />
        ) : (
          <ClayTable
            headers={["Ref", "Type", "Detail", "Amount", "Responsible", "Status", ""]}
            isEmpty={exceptions.length === 0}
            emptyMessage="No exceptions — every naira reconciles. 🎉"
          >
            {[...open, ...resolved].map((e: any) => (
              <tr key={e._id} className="border-t border-border/50">
                <td className="px-3 py-2.5 font-mono text-xs">{e.exceptionRef}</td>
                <td className="px-3 py-2.5">
                  <Badge variant="outline">{e.type.replace(/_/g, " ")}</Badge>
                </td>
                <td className="max-w-md px-3 py-2.5 text-xs text-muted-foreground">
                  {e.description}
                  {e.resolutionNotes && (
                    <p className="mt-1 text-[#007A4D]">✓ {e.resolutionNotes}</p>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {e.amount != null ? fmtNaira(e.amount) : "—"}
                </td>
                <td className="px-3 py-2.5 text-xs capitalize text-muted-foreground">
                  {e.responsibleParty}
                </td>
                <td className="px-3 py-2.5">
                  <StatusPill status={e.status === "open" ? "exception" : "reconciled"} />
                </td>
                <td className="px-3 py-2.5 text-right">
                  {e.status === "open" && (
                    <Button size="sm" variant="outline" onClick={() => setResolving(e)}>
                      <CheckCircle2 className="size-4" /> Resolve
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </ClayTable>
        )}
      </section>

      {/* Resolve dialog */}
      <Dialog open={!!resolving} onOpenChange={(o) => !o && setResolving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve exception {resolving?.exceptionRef}</DialogTitle>
            <DialogDescription>
              Record how this exception was investigated and corrected. The note is added to the
              immutable audit trail.
            </DialogDescription>
          </DialogHeader>
          <p className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
            {resolving?.description}
          </p>
          <Textarea
            placeholder="Resolution notes (e.g. contacted PFA, schedule corrected and reposted)…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <DialogFooter>
            <Button
              className="font-semibold w-full sm:w-auto"
              onClick={handleResolve}
              disabled={saving}
            >
              {saving ? "Saving…" : "Mark resolved"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardShell>
  );
}
