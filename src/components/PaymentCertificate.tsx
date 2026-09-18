import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Logo } from "@/components/Brand";
import {
  Download,
  FileText,
  Printer,
  ShieldCheck,
} from "lucide-react";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import {
  downloadCsv,
  fmtDate,
  fmtNaira,
  monthName,
  statusLabel,
  statusTone,
  verificationCode,
} from "@/lib/pension";

interface CertificateProps {
  batch: Doc<"contributionBatches">;
  employer: Doc<"employers"> | null;
  records: Doc<"contributionRecords">[];
  settlements: (Doc<"settlements"> & { pfaName?: string; pfaCode?: string })[];
}

const toneDot: Record<string, string> = {
  green: "bg-[#007A4D]", blue: "bg-[#2276A8]", violet: "bg-[#5B60A8]",
  amber: "bg-[#D4AF37]", red: "bg-[#C4453C]", slate: "bg-[#8299A5]",
};

/**
 * PENROUTE PAYMENT RECEIPT (audit document).
 * Shows "Successfully Processed" only when reconciliation has passed.
 * (Legacy name `PaymentCertificate` is kept as an alias.)
 */
export function PaymentReceipt({ batch, employer, records, settlements }: CertificateProps) {
  const verified = batch.reconciliationStatus === "reconciled" && batch.status === "completed";

  const handlePrint = () => window.print();
  const handleCsv = () => {
    downloadCsv(`pension-certificate-${batch.batchRef}.csv`, [
      ["PENSION CONTRIBUTION PAYMENT CERTIFICATE"],
      [],
      ["Employer", employer?.name ?? ""],
      ["Employer Registration Number", employer?.rcNumber ?? ""],
      ["TIN", employer?.tin ?? ""],
      ["Contribution Month", `${monthName(batch.contributionMonth)} ${batch.contributionYear}`],
      ["Payment Date", fmtDate(batch.paymentDate)],
      ["Batch ID", batch.batchRef],
      ["Payment Reference", batch.paymentRef ?? ""],
      ["Verification Code", verificationCode(batch.batchRef, batch.paymentRef, batch.totalDebit)],
      [],
      ["Employee", "Employee ID", "Pension PIN", "PFA", "Employee Contribution", "Employer Contribution", "Total", "PFA Status"],
      ...records.map((r) => [
        r.fullName,
        r.employeeCode,
        r.pensionPin,
        settlements.find((s) => String(s.pfaId) === String(r.pfaId))?.pfaName ?? "",
        (r.employeeContribution / 100).toFixed(2),
        (r.employerContribution / 100).toFixed(2),
        (r.totalAmount / 100).toFixed(2),
        statusLabel(r.pfaStatus),
      ]),
      [],
      ["Total Employees", records.length],
      ["Total Employee Contributions", (batch.totalEmployeeContribution / 100).toFixed(2)],
      ["Total Employer Contributions", (batch.totalEmployerContribution / 100).toFixed(2)],
      ["Total Pension Contribution", (batch.totalPensionAmount / 100).toFixed(2)],
      ["Processing Fees", (batch.platformFee / 100).toFixed(2)],
      ["Total Amount Paid", (batch.totalDebit / 100).toFixed(2)],
      [],
      ["Payment Status", statusLabel(batch.paymentStatus)],
      ["Allocation Status", statusLabel(batch.allocationStatus)],
      ["Settlement Status", statusLabel(batch.settlementStatus)],
      ["PFA Acknowledgement", statusLabel(batch.pfaStatus)],
      ["Reconciliation Status", statusLabel(batch.reconciliationStatus)],
    ]);
  };

  const pfaBreakdown = new Map<string, { name: string; amount: number; count: number }>();
  for (const s of settlements) {
    pfaBreakdown.set(String(s.pfaId), {
      name: s.pfaName ?? "PFA",
      amount: s.amount,
      count: s.employeeCount,
    });
  }

  return (
    <div className="print-area">
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileText className="size-5 text-[#007A4D]" />
          <h3 className="font-bold tracking-tight text-[#0B1F2A]">Payment Receipt</h3>
          {verified && (
            <Badge className="border-[#BCE6D4] bg-[#E6F6EF] text-[#04593A]">
              <ShieldCheck className="size-3.5" /> Successfully Processed
            </Badge>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="border-[#0B1F2A]/15 font-semibold text-[#0B1F2A]"
            onClick={handleCsv}
          >
            <Download className="size-4" /> CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-[#0B1F2A]/15 font-semibold text-[#0B1F2A]"
            onClick={handlePrint}
          >
            <Printer className="size-4" /> Print / PDF
          </Button>
        </div>
      </div>

      <div className="pen-card-lg p-6 sm:p-8">
        {/* Header — Penroute branded */}
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
          <div>
            <Logo size="sm" tagline />
            <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.18em] text-[#5A6B74]">
              Pension Contribution Payment Receipt
            </p>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-[#0B1F2A]">
              {monthName(batch.contributionMonth)} {batch.contributionYear}
            </h2>
            <p className="mt-1 text-sm text-[#5A6B74]">
              {employer?.name ?? "Employer"} · RC {employer?.rcNumber ?? "—"} · TIN {employer?.tin ?? "—"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#5A6B74]">Amount Paid</p>
            <p className="text-2xl font-bold tabular-nums text-[#0B1F2A]">{fmtNaira(batch.totalDebit)}</p>
            <p className="text-xs text-[#5A6B74]">{fmtDate(batch.paymentDate)}</p>
          </div>
        </div>

        {/* References */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 py-5 sm:grid-cols-4">
          {[
            ["Batch ID", batch.batchRef],
            ["Payment Ref", batch.paymentRef ?? "—"],
            ["Employees", String(records.length)],
            ["Verification", verificationCode(batch.batchRef, batch.paymentRef, batch.totalDebit)],
          ].map(([k, v]) => (
            <div key={k}>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-[#5A6B74]">{k}</p>
              <p className="mt-0.5 truncate text-sm font-semibold tabular-nums text-[#0B1F2A]" title={v}>{v}</p>
            </div>
          ))}
        </div>

        {/* Status grid */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            ["Payment", batch.paymentStatus],
            ["Allocation", batch.allocationStatus],
            ["Settlement", batch.settlementStatus],
            ["PFA", batch.pfaStatus],
            ["Reconciliation", batch.reconciliationStatus],
          ].map(([label, st]) => (
            <div key={label} className="pen-tile p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-[#5A6B74]">{label}</p>
              <span className="pill mt-2" data-tone={statusTone(st)}>
                <span className={`pill-dot ${toneDot[statusTone(st)]}`} />
                {statusLabel(st)}
              </span>
            </div>
          ))}
        </div>

        {/* PFA breakdown */}
        <Separator className="my-5" />
        <h4 className="text-sm font-bold tracking-tight text-[#0B1F2A]">PFA Settlement Breakdown</h4>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {settlements.length === 0 && (
            <p className="text-sm text-[#5A6B74]">Settlement instructions pending…</p>
          )}
          {[...pfaBreakdown.entries()].map(([id, g]) => (
            <div key={id} className="pen-inset p-3">
              <p className="truncate text-sm font-semibold text-[#0B1F2A]">{g.name}</p>
              <p className="mt-1 text-lg font-bold tabular-nums text-[#0B1F2A]">{fmtNaira(g.amount)}</p>
              <p className="text-xs text-[#5A6B74]">{g.count} employees</p>
            </div>
          ))}
        </div>

        {/* Totals */}
        <Separator className="my-5" />
        <div className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          {[
            ["Total Employee Contributions", fmtNaira(batch.totalEmployeeContribution)],
            ["Total Employer Contributions", fmtNaira(batch.totalEmployerContribution)],
            ["Total Pension Contribution", fmtNaira(batch.totalPensionAmount)],
            ["Processing Fees", fmtNaira(batch.platformFee)],
            ["Total Amount Paid", fmtNaira(batch.totalDebit)],
          ].map(([k, v], i) => (
            <div key={k} className={`flex items-center justify-between ${i === 4 ? "col-span-full border-t border-border pt-2 font-bold text-[#0B1F2A]" : ""}`}>
              <span className={i === 4 ? "" : "text-[#5A6B74]"}>{k}</span>
              <span className="tabular-nums">{v}</span>
            </div>
          ))}
        </div>

        {/* Employee schedule */}
        <Separator className="my-5" />
        <h4 className="text-sm font-bold tracking-tight text-[#0B1F2A]">Employee Contribution Schedule</h4>
        <div className="pen-inset mt-3 max-h-80 overflow-auto p-2">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="text-left text-[11px] uppercase tracking-wide text-[#5A6B74]">
                <th className="px-2 py-2 font-semibold">Employee</th>
                <th className="px-2 py-2 font-semibold">Pension PIN</th>
                <th className="px-2 py-2 font-semibold">PFA</th>
                <th className="px-2 py-2 text-right font-semibold">Employee ₦</th>
                <th className="px-2 py-2 text-right font-semibold">Employer ₦</th>
                <th className="px-2 py-2 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r._id} className="border-t border-[#EDF0F2]">
                  <td className="px-2 py-2 font-medium text-[#0B1F2A]">{r.fullName}</td>
                  <td className="px-2 py-2 tabular-nums text-muted-foreground">{r.pensionPin}</td>
                  <td className="px-2 py-2 text-muted-foreground">
                    {settlements.find((s) => String(s.pfaId) === String(r.pfaId))?.pfaName ?? "—"}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtNaira(r.employeeContribution)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtNaira(r.employerContribution)}</td>
                  <td className="px-2 py-2 text-right font-semibold tabular-nums">{fmtNaira(r.totalAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-center text-[11px] text-[#8299A5]">
          System-generated document · Verification code {verificationCode(batch.batchRef, batch.paymentRef, batch.totalDebit)} ·
          Suitable for accounting, HR and audit records.
        </p>
      </div>
    </div>
  );
}

/** Back-compat alias (Batches page + tests may import the old name). */
export const PaymentCertificate = PaymentReceipt;
