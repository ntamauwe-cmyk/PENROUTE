import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PaymentCertificate } from "@/components/PaymentCertificate";
import { DashboardShell } from "@/components/DashboardShell";
import { ClayTable, LoadingBlock, PageHeader, StatusPill } from "@/components/pension-ui";
import { FileText } from "lucide-react";
import { fmtDate, fmtNaira, monthName } from "@/lib/pension";

export default function Batches() {
  const dash = useQuery(api.pension.getEmployerDashboard);
  const batches = useMemo(() => dash?.batches ?? [], [dash]);
  const loading = dash === undefined;
  const [certBatchId, setCertBatchId] = useState<string | null>(null);
  const detail = useQuery(
    api.pension.getBatchDetail,
    certBatchId ? { batchId: certBatchId as Id<"contributionBatches"> } : "skip",
  );

  const sorted = useMemo(
    () => [...batches].sort((a, b) => b.createdAt - a.createdAt),
    [batches],
  );

  return (
    <DashboardShell>
      <PageHeader
        title="Payment Batches"
        description="Every monthly contribution batch with its full pipeline status."
      />

      {!loading && batches.length === 0 ? (
        <ClayTable
          headers={[]}
          isEmpty
          emptyMessage="No batches yet — start your first contribution from the Dashboard."
        >
          <></>
        </ClayTable>
      ) : loading ? (
        <LoadingBlock label="Loading batches…" />
      ) : (
        <ClayTable
          headers={["Batch", "Period", "Employees", "Pension", "Fee", "Total paid", "Status", "Paid on", ""]}
          isEmpty={false}
          emptyMessage=""
        >
          {sorted.map((b) => (
            <tr key={b._id} className="pen-table-row">
              <td className="px-3 py-2.5 font-mono text-xs font-medium">{b.batchRef}</td>
              <td className="px-3 py-2.5 font-medium">
                {monthName(b.contributionMonth)} {b.contributionYear}
              </td>
              <td className="px-3 py-2.5 tabular-nums">{b.employeeCount}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                {fmtNaira(b.totalPensionAmount)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                {fmtNaira(b.platformFee)}
              </td>
              <td className="px-3 py-2.5 text-right font-semibold tabular-nums">
                {fmtNaira(b.totalDebit)}
              </td>
              <td className="px-3 py-2.5">
                <StatusPill status={b.status} />
              </td>
              <td className="px-3 py-2.5 text-muted-foreground">{fmtDate(b.paymentDate)}</td>
              <td className="px-3 py-2.5 text-right">
                {b.status === "completed" && (
                  <Button size="sm" variant="ghost" onClick={() => setCertBatchId(b._id)}>
                    <FileText className="size-4" /> Certificate
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </ClayTable>
      )}

      {/* Certificate dialog */}
      <Dialog open={!!certBatchId} onOpenChange={(open) => !open && setCertBatchId(null)}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-auto">
          <DialogHeader>
            <DialogTitle>Payment certificate</DialogTitle>
            <DialogDescription>
              Audit-ready record — print or export for accounting and HR files.
            </DialogDescription>
          </DialogHeader>
          {certBatchId && detail ? (
            <PaymentCertificate
              batch={detail.batch}
              employer={dash?.employer ?? null}
              records={detail.records.filter((r) => r.validationStatus === "valid")}
              settlements={detail.settlements}
            />
          ) : (
            <LoadingBlock label="Preparing certificate…" />
          )}
        </DialogContent>
      </Dialog>
    </DashboardShell>
  );
}
