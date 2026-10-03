import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { DashboardShell } from "@/components/DashboardShell";
import { ClayTable, LoadingBlock, PageHeader, StatusPill, useEmployer } from "@/components/pension-ui";
import { fmtDateTime, fmtNaira } from "@/lib/pension";
import { Badge } from "@/components/ui/badge";

export default function Transactions() {
  const payments = useQuery(api.pension.listEmployerPayments);
  const { batches } = useEmployer();

  const batchRefById = new Map(batches.map((b) => [b._id, b.batchRef]));
  const reconByBatch = new Map<string, string>(
    batches.map((b) => [b._id, b.reconciliationStatus]),
  );

  return (
    <DashboardShell>
      <PageHeader
        title="Transactions"
        description="Consolidated payments — pension contributions routed to PFAs are shown separately from Penroute's processing fee (a technology/service charge, not a pension contribution)."
      />

      {!payments ? (
        <LoadingBlock label="Loading transactions…" />
      ) : (
        <ClayTable
          headers={[
            "Payment ref",
            "Batch",
            "Total Processed",
            "Pension Contribution",
            "Penroute Processing Fee",
            "Rail",
            "Processing Status",
            "Reconciliation Status",
            "Initiated",
          ]}
          isEmpty={payments.length === 0}
          emptyMessage="No transactions yet — payments appear here after your first contribution."
        >
          {payments.map((p) => (
            <tr key={p._id} className="pen-table-row">
              <td className="px-3 py-2.5">
                <p className="font-mono text-xs font-semibold">{p.paymentRef}</p>
                {p.providerRef && (
                  <p className="font-mono text-[10px] text-muted-foreground">{p.providerRef}</p>
                )}
              </td>
              <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
                {batchRefById.get(p.batchId) ?? "—"}
              </td>
              <td className="px-3 py-2.5 text-right font-semibold tabular-nums">
                {fmtNaira(p.amount)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">{fmtNaira(p.pensionAmount)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                {fmtNaira(p.platformFee)}
              </td>
              <td className="px-3 py-2.5">
                <Badge variant="outline">{p.rail.replace(/_/g, " ")}</Badge>
              </td>
              <td className="px-3 py-2.5">
                <StatusPill status={p.status} />
              </td>
              <td className="px-3 py-2.5">
                <StatusPill status={reconByBatch.get(p.batchId) ?? "pending"} />
              </td>
              <td className="px-3 py-2.5 text-muted-foreground">{fmtDateTime(p.initiatedAt)}</td>
            </tr>
          ))}
        </ClayTable>
      )}
    </DashboardShell>
  );
}
