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
  const [pfaFilter, setPfaFilter] = useState("all");
  // PFA report rows (real backend aggregates — employer-scoped or platform-wide).
  const pfaReport = useQuery(api.pfaDirectory.getPfaReports);

  const years = useMemo(
    () => [...new Set(batches.map((b: any) => b.contributionYear))].sort((a, b) => b - a),
    [batches],
  );

  // Which batch refs touch the selected PFA (empty set = no PFA activity).
  const pfaBatchRefs = useMemo(() => {
    if (pfaFilter === "all" || !pfaReport) return null;
    const row = pfaReport.rows.find((r: any) => r.pfaId === pfaFilter);
    return new Set(row?.batchRefs ?? []);
  }, [pfaFilter, pfaReport]);

  const filtered = batches.filter((b: any) => {
    const mOk = monthFilter === "all" || String(b.contributionMonth) === monthFilter;
    const yOk = yearFilter === "all" || String(b.contributionYear) === yearFilter;
    const pfaOk = pfaBatchRefs === null || pfaBatchRefs.has(b.batchRef);
    return mOk && yOk && pfaOk;
  });

  const reportRows = useMemo(() => {
    if (!pfaReport) return [];
    return pfaFilter === "all"
      ? pfaReport.rows
      : pfaReport.rows.filter((r: any) => r.pfaId === pfaFilter);
  }, [pfaReport, pfaFilter]);

  const reportTotals = reportRows.reduce(
    (acc: any, r: any) => ({
      employees: acc.employees + r.employeesCount,
      contributions: acc.contributions + r.totalContribution,
      remitted: acc.remitted + r.remittedAmount,
      pending: acc.pending + r.pendingAmount,
      failed: acc.failed + r.failedAmount,
      reconciled: acc.reconciled + r.reconciledAmount,
      unreconciled: acc.unreconciled + r.unreconciledAmount,
    }),
    { employees: 0, contributions: 0, remitted: 0, pending: 0, failed: 0, reconciled: 0, unreconciled: 0 },
  );

  const exportPfaCsv = () => {
    const headers: (string | number)[] = [
      "PFA",
      "PFA ID",
      "Status",
      "Integration",
      "Employees",
    ];
    if (pfaReport?.isAdmin) headers.push("Employers");
    headers.push(
      "Employee contributions",
      "Employer contributions",
      "Total contributions",
      "Successful remittances",
      "Pending transactions",
      "Failed transactions",
      "Reconciled",
      "Unreconciled",
      "Last contribution",
    );
    downloadCsv("pension-activity-by-pfa.csv", [
      ["PENSION ACTIVITY BY PFA"],
      ["Generated", new Date().toISOString()],
      [],
      headers,
      ...reportRows.map((r: any) => {
        const row: (string | number)[] = [
          r.name,
          r.slug ?? "",
          r.active ? "Active" : "Inactive",
          r.integrationStatusLabel,
          r.employeesCount,
        ];
        if (pfaReport?.isAdmin) row.push(r.employersCount ?? 0);
        row.push(
          (r.totalEmployeeContribution / 100).toFixed(2),
          (r.totalEmployerContribution / 100).toFixed(2),
          (r.totalContribution / 100).toFixed(2),
          (r.remittedAmount / 100).toFixed(2),
          (r.pendingAmount / 100).toFixed(2),
          (r.failedAmount / 100).toFixed(2),
          (r.reconciledAmount / 100).toFixed(2),
          (r.unreconciledAmount / 100).toFixed(2),
          r.lastContributionAt ? new Date(r.lastContributionAt).toISOString() : "",
        );
        return row;
      }),
      [],
      [
        "TOTALS",
        "",
        "",
        "",
        reportTotals.employees,
        ...(pfaReport?.isAdmin ? [""] : []),
        "",
        "",
        (reportTotals.contributions / 100).toFixed(2),
        (reportTotals.remitted / 100).toFixed(2),
        (reportTotals.pending / 100).toFixed(2),
        (reportTotals.failed / 100).toFixed(2),
        (reportTotals.reconciled / 100).toFixed(2),
        (reportTotals.unreconciled / 100).toFixed(2),
      ],
    ]);
  };

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
        title="Statements & PFA reports"
        description="Historical contribution statements and pension activity by PFA — filter by period or PFA and export for your records."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={exportPfaCsv} disabled={reportRows.length === 0}>
              <Download className="size-4" /> PFA report CSV
            </Button>
            <Button variant="outline" onClick={exportCsv} disabled={filtered.length === 0}>
              <Download className="size-4" /> Export CSV
            </Button>
          </div>
        }
      />

      {/* Pension activity by PFA — real aggregates from the backend */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
              Pension activity by PFA
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {pfaReport?.isAdmin
                ? "Platform-wide contributions, remittances and reconciliation per PFA."
                : "Your organisation's contributions, remittances and reconciliation per PFA."}
            </p>
          </div>
          <div className="w-56 no-print">
            <Select value={pfaFilter} onValueChange={setPfaFilter}>
              <SelectTrigger className="w-full cursor-pointer">
                <SelectValue placeholder="All PFAs" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All PFAs</SelectItem>
                {(pfaReport?.rows ?? []).map((r: any) => (
                  <SelectItem key={r.pfaId} value={r.pfaId}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {!pfaReport ? (
          <LoadingBlock label="Loading PFA report…" />
        ) : (
          <div className="pen-card overflow-x-auto p-1.5">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2.5 font-semibold">PFA</th>
                  <th className="px-3 py-2.5 font-semibold">Employees</th>
                  {pfaReport.isAdmin && <th className="px-3 py-2.5 font-semibold">Employers</th>}
                  <th className="px-3 py-2.5 font-semibold text-right">Contributions</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Remitted</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Pending</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Failed</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Reconciled</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Unreconciled</th>
                  <th className="px-3 py-2.5 font-semibold">Last</th>
                </tr>
              </thead>
              <tbody>
                {reportRows.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-3 py-8 text-center text-sm text-muted-foreground">
                      No PFA activity matches the selected filters.
                    </td>
                  </tr>
                ) : (
                  reportRows.map((r: any) => (
                    <tr key={r.pfaId} className="pen-table-row">
                      <td className="px-3 py-2.5">
                        <span className="block font-medium leading-tight">{r.name}</span>
                        <span className="block font-mono text-[11px] text-muted-foreground">
                          {r.slug ?? "—"} · {r.active ? "Active" : "Inactive"} · {r.integrationStatusLabel}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums">{r.employeesCount}</td>
                      {pfaReport.isAdmin && (
                        <td className="px-3 py-2.5 tabular-nums">{r.employersCount ?? 0}</td>
                      )}
                      <td className="px-3 py-2.5 text-right font-semibold tabular-nums">
                        {fmtNaira(r.totalContribution)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-[#007A4D]">
                        {r.remittedAmount > 0 ? fmtNaira(r.remittedAmount) : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {r.pendingAmount > 0 ? fmtNaira(r.pendingAmount) : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-destructive">
                        {r.failedAmount > 0 ? fmtNaira(r.failedAmount) : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {r.reconciledAmount > 0 ? fmtNaira(r.reconciledAmount) : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {r.unreconciledAmount > 0 ? (
                          <span className="font-semibold text-[#8A6D1F]">{fmtNaira(r.unreconciledAmount)}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {fmtDate(r.lastContributionAt ?? undefined)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
        <div className="w-40">
          <Label>PFA</Label>
          <Select value={pfaFilter} onValueChange={setPfaFilter}>
            <SelectTrigger className="mt-1.5 w-full cursor-pointer">
              <SelectValue placeholder="All PFAs" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All PFAs</SelectItem>
              {(pfaReport?.rows ?? []).map((r: any) => (
                <SelectItem key={r.pfaId} value={r.pfaId}>
                  {r.name}
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
