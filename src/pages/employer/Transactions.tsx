import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { DashboardShell } from "@/components/DashboardShell";
import { ClayTable, LoadingBlock, PageHeader, StatusPill, useEmployer } from "@/components/pension-ui";
import { fmtDateTime, fmtNaira } from "@/lib/pension";
import { Badge } from "@/components/ui/badge";

export default function Transactions() {
  const payments = useQuery(api.pension.listEmployerPayments);
  const { batches } = useEmployer();

  const batchRefById = new Map(batches.map((b: any) => [b._id, b.batchRef]));

  return (
    <DashboardShell>
      <PageHeader
        title="Transactions"
        description="Your consolidated payments — one payment per monthly batch, with fee and pension split."
      />

      {!payments ? (
        <LoadingBlock label="Loading transactions…" />
      ) : (
        <ClayTable
          headers={["Payment ref", "Batch", "Amount", "Pension portion", "Platform fee", "Rail", "Status", "Initiated"]}
          isEmpty={payments.length === 0}
          emptyMessage="No transactions yet — payments appear here after your first contribution."
        >
          {payments.map((p: any) => (
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
              <td className="px-3 py-2.5 text-muted-foreground">{fmtDateTime(p.initiatedAt)}</td>
            </tr>
          ))}
        </ClayTable>
      )}
    </DashboardShell>
  );
}
