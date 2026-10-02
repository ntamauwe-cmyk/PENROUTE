import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DashboardShell } from "@/components/DashboardShell";
import { ClayTable, LoadingBlock, PageHeader, StatusPill, useEmployer } from "@/components/pension-ui";
import { downloadCsv, fmtDate, fmtNaira, monthName, MONTHS } from "@/lib/pension";
import { Download } from "lucide-react";

export default function Statements() {
  const { batches, loading } = useEmployer();
  const [monthFilter, setMonthFilter] = useState("all");
  const [yearFilter, setYearFilter] = useState("all");

  const years = useMemo(
    () => [...new Set(batches.map((b: any) => b.contributionYear))].sort((a, b) => b - a),
    [batches],
  );

  const filtered = batches.filter((b: any) => {
    const mOk = monthFilter === "all" || String(b.contributionMonth) === monthFilter;
    const yOk = yearFilter === "all" || String(b.contributionYear) === yearFilter;
    return mOk && yOk;
  });

  const totals = filtered.reduce(
    (acc: any, b: any) => ({
      employees: acc.employees + b.employeeCount,
      pension: acc.pension + b.totalPensionAmount,
      fees: acc.fees + b.platformFee,
      paid: acc.paid + b.totalDebit,
    }),
    { employees: 0, pension: 0, fees: 0, paid: 0 },
  );

  const exportCsv = () => {
    downloadCsv("contribution-statement.csv", [
      ["MONTHLY CONTRIBUTION STATEMENT"],
      ["Generated", new Date().toISOString()],
      [],
      ["Period", "Batch", "Employees", "Employee contributions", "Employer contributions", "Pension total", "Processing fee", "Total paid", "Status", "Paid on"],
      ...filtered.map((b: any) => [
        `${monthName(b.contributionMonth)} ${b.contributionYear}`,
        b.batchRef,
        b.employeeCount,
        (b.totalEmployeeContribution / 100).toFixed(2),
        (b.totalEmployerContribution / 100).toFixed(2),
        (b.totalPensionAmount / 100).toFixed(2),
        (b.platformFee / 100).toFixed(2),
        (b.totalDebit / 100).toFixed(2),
        b.status,
        b.paymentDate ? new Date(b.paymentDate).toISOString() : "",
      ]),
      [],
      ["TOTALS", "", totals.employees, "", "", (totals.pension / 100).toFixed(2), (totals.fees / 100).toFixed(2), (totals.paid / 100).toFixed(2)],
    ]);
  };

  return (
    <DashboardShell>
      <PageHeader
        title="Statements"
        description="Historical contribution statements — filter by period and export for your records."
        actions={
          <Button variant="outline" onClick={exportCsv} disabled={filtered.length === 0}>
            <Download className="size-4" /> Export CSV
          </Button>
        }
      />

      {/* Filters */}
      <div className="clay flex flex-wrap items-end gap-4 p-4">
        <div className="w-40">
          <Label>Month</Label>
          <Select value={monthFilter} onValueChange={setMonthFilter}>
            <SelectTrigger className="mt-1.5 w-full cursor-pointer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All months</SelectItem>
              {MONTHS.map((m, i) => (
                <SelectItem key={m} value={String(i + 1)}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-32">
          <Label>Year</Label>
          <Select value={yearFilter} onValueChange={setYearFilter}>
            <SelectTrigger className="mt-1.5 w-full cursor-pointer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All years</SelectItem>
              {years.map((y: any) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto flex gap-3 text-right">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Pension total
            </p>
            <p className="text-lg font-bold tabular-nums">{fmtNaira(totals.pension)}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Fees
            </p>
            <p className="text-lg font-bold tabular-nums">{fmtNaira(totals.fees)}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Total paid
            </p>
            <p className="text-lg font-bold tabular-nums">{fmtNaira(totals.paid)}</p>
          </div>
        </div>
      </div>

      {!loading ? (
        <ClayTable
          headers={["Period", "Batch", "Employees", "Pension", "Fee", "Total paid", "Status", "Paid on"]}
          isEmpty={filtered.length === 0}
          emptyMessage="No contributions match the selected filters."
        >
          {filtered.map((b: any) => (
            <tr key={b._id} className="pen-table-row">
              <td className="px-3 py-2.5 font-medium">
                {monthName(b.contributionMonth)} {b.contributionYear}
              </td>
              <td className="px-3 py-2.5 font-mono text-xs">{b.batchRef}</td>
              <td className="px-3 py-2.5 tabular-nums">{b.employeeCount}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{fmtNaira(b.totalPensionAmount)}</td>
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
            </tr>
          ))}
        </ClayTable>
      ) : (
        <LoadingBlock label="Loading statements…" />
      )}
    </DashboardShell>
  );
}
