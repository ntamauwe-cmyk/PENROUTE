import { useState } from "react";
import { friendlyError } from "@/lib/errors";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtNaira, monthName } from "@/lib/pension";
import { CalendarClock, CheckCircle2, Download, ShieldCheck, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const STATUS: Record<string, { label: string; cls: string }> = {
  on_time: { label: "Paid on time", cls: "bg-[#E6F6EF] text-[#04593A]" },
  late: { label: "Paid late", cls: "bg-[#FBF3E0] text-[#7A5A10]" },
  overdue: { label: "Overdue", cls: "bg-[#FBEAE8] text-[#8A2F28]" },
  due: { label: "Due", cls: "bg-[#FBF3E0] text-[#7A5A10]" },
  not_due: { label: "Upcoming", cls: "bg-[#EEF2F4] text-[#5A6B74]" },
};

/** Dashboard card: the remittance obligation that needs action now. */
export function RemittanceDeadlineCard({ onPay }: { onPay?: () => void }) {
  const rec = useQuery(api.compliance.getComplianceRecord);
  if (!rec?.current) return null;
  const c = rec.current;
  const overdue = c.status === "overdue";
  const tone = overdue ? "border-[#C4453C]/30 bg-[#FBEAE8]" : c.daysLeft <= 3 ? "border-[#D4AF37]/40 bg-[#FBF3E0]" : "border-[#E5E9EC] bg-white";
  return (
    <section className={`pen-card flex flex-col gap-3 border p-5 sm:flex-row sm:items-center sm:justify-between ${tone}`}>
      <div className="flex items-start gap-3">
        {overdue ? (
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-[#C4453C]" />
        ) : (
          <CalendarClock className="mt-0.5 size-5 shrink-0 text-[#007A4D]" />
        )}
        <div>
          <p className="font-bold tracking-tight text-[#0B1F2A]">
            {monthName(c.month)} {c.year} contributions —{" "}
            {overdue
              ? `overdue by ${Math.abs(c.daysLeft)} day${Math.abs(c.daysLeft) === 1 ? "" : "s"}`
              : c.daysLeft === 0
                ? "due today"
                : `due in ${c.daysLeft} day${c.daysLeft === 1 ? "" : "s"}`}
          </p>
          <p className="text-sm text-[#5A6B74]">
            Statutory deadline {fmtDay(c.deadline)} (7 working days after salary on {fmtDay(c.salaryDate)}
            {rec.assumedPayDay ? `, assumed day ${rec.assumedPayDay} — set your pay day in Settings` : ""}).
            {overdue && " Late remittance attracts penalties under the Pension Reform Act 2014."}
          </p>
        </div>
      </div>
      {onPay && (
        <Button className="shrink-0 bg-[#007A4D] font-semibold hover:bg-[#006A43]" onClick={onPay}>
          Pay {monthName(c.month)}
        </Button>
      )}
    </section>
  );
}

/** Settings: the day salaries are paid (drives every deadline). */
export function SalaryPayDaySetting() {
  const rec = useQuery(api.compliance.getComplianceRecord);
  const save = useMutation(api.compliance.setSalaryPayDay);
  const [value, setValue] = useState<string | null>(null);
  const current = value ?? String(rec?.salaryPayDay ?? "");
  return (
    <section className="pen-card-lg p-6">
      <h2 className="flex items-center gap-2 font-bold tracking-tight">
        <CalendarClock className="size-5 text-primary" /> Salary pay day
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The day of the month you pay salaries. Penroute uses it to compute each month's statutory
        remittance deadline (7 working days later) and to remind you before it passes.
      </p>
      <div className="mt-4 flex items-center gap-2">
        <Input
          type="number"
          min={1}
          max={31}
          className="w-24"
          aria-label="Salary pay day"
          placeholder={String(rec?.assumedPayDay ?? 25)}
          value={current}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button
          onClick={async () => {
            try {
              await save({ day: Number(current) });
              toast.success("Pay day saved — deadlines updated");
              setValue(null);
            } catch (e) {
              toast.error(friendlyError(e, "Could not save"));
            }
          }}
          disabled={!current}
        >
          Save
        </Button>
      </div>
    </section>
  );
}

/** Reports: month-by-month remittance compliance record with CSV export. */
export function ComplianceRecord() {
  const rec = useQuery(api.compliance.getComplianceRecord);
  if (!rec) return null;
  const exportCsv = () => {
    const header = ["Period", "Salary date", "Statutory deadline", "Paid on", "Status", "Posted to PFAs", "Employees", "Pension amount (NGN)", "Batch"];
    const lines = rec.rows.map((r) =>
      [r.period, r.salaryDate, r.deadline, r.paidOn ?? "", STATUS[r.status].label, r.posted ? "Yes" : "No", r.employees, (r.pensionKobo / 100).toFixed(2), r.batchRef ?? ""]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `penroute-remittance-compliance-${rec.today}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <section className="pen-card-lg p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-bold tracking-tight">
            <ShieldCheck className="size-5 text-primary" /> Remittance compliance record
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Every month since you joined, against the 7-working-day statutory deadline — evidence for a
            PenCom compliance certificate application.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={rec.rows.length === 0}>
          <Download className="size-4" /> Export CSV
        </Button>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["On-time rate", rec.summary.onTimeRate === null ? "—" : `${rec.summary.onTimeRate}%`],
          ["Paid on time", String(rec.summary.onTime)],
          ["Paid late", String(rec.summary.late)],
          ["Overdue now", String(rec.summary.overdue)],
        ].map(([k, v]) => (
          <div key={k} className="pen-inset p-3">
            <p className="text-xs text-[#5A6B74]">{k}</p>
            <p className="mt-0.5 text-lg font-bold tabular-nums">{v}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2">Period</th>
              <th className="px-3 py-2">Deadline</th>
              <th className="px-3 py-2">Paid on</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Posted</th>
              <th className="px-3 py-2 text-right">Pension</th>
            </tr>
          </thead>
          <tbody>
            {rec.rows.map((r) => (
              <tr key={r.period} className="border-t border-border/50">
                <td className="px-3 py-2.5 font-medium">{monthName(r.month)} {r.year}</td>
                <td className="px-3 py-2.5">{fmtDay(r.deadline)}</td>
                <td className="px-3 py-2.5">{r.paidOn ? fmtDay(r.paidOn) : "—"}</td>
                <td className="px-3 py-2.5">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS[r.status].cls}`}>
                    {STATUS[r.status].label}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  {r.posted ? <CheckCircle2 className="size-4 text-[#007A4D]" aria-label="Posted" /> : "—"}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{r.pensionKobo ? fmtNaira(r.pensionKobo) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
