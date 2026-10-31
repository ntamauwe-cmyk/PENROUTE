import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusPill } from "@/components/pension-ui";
import { friendlyError } from "@/lib/errors";
import { fmtNaira, monthName } from "@/lib/pension";
import { Download, ExternalLink, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

/**
 * Approved-provider route: the employer pays on the PenCom-approved
 * provider's platform with the schedule Penroute prepared, then records the
 * provider's reference. Nothing is shown as paid until the provider's signed
 * confirmation, or a Penroute administrator checking the provider's records,
 * confirms it.
 */
export function PartnerPaymentPanel({ batchId, onDone }: { batchId: Id<"contributionBatches">; onDone?: () => void }) {
  const schedule = useQuery(api.remittancePartner.getPartnerSchedule, { batchId });
  const route = useQuery(api.remittancePartner.getEmployerRoute);
  const declare = useMutation(api.remittancePartner.declarePartnerPayment);
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);

  if (!schedule) {
    return (
      <div className="pen-card flex items-center gap-2 p-5 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Preparing your remittance schedule…
      </div>
    );
  }
  const partnerName = schedule.partnerName ?? route?.partner?.name ?? "the approved provider";
  const portalUrl = route?.partner?.portalUrl;

  const downloadCsv = () => {
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const n = (k: number) => (k / 100).toFixed(2);
    const header = [
      "S/N", "Employee name", "Staff ID", "RSA PIN", "PFA code", "PFA name",
      "Employee contribution (NGN)", "Employer contribution (NGN)", "Total (NGN)", "Month", "Year",
    ];
    const lines = schedule.rows.map((r, i) =>
      [String(i + 1), r.fullName, r.employeeCode, r.pensionPin, r.pfaCode, r.pfaName, n(r.employeeKobo), n(r.employerKobo), n(r.totalKobo), String(schedule.month), String(schedule.year)]
        .map(esc)
        .join(","),
    );
    const meta = [
      `# Employer,${esc(schedule.employer.name)}`,
      `# RC number,${esc(schedule.employer.rcNumber)}`,
      `# Penroute reference,${schedule.paymentRef ?? ""}`,
      `# Batch,${schedule.batchRef}`,
      `# Total to remit (NGN),${n(schedule.amountKobo)}`,
    ];
    const blob = new Blob([[...meta, header.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pension-schedule-${schedule.year}-${String(schedule.month).padStart(2, "0")}-${schedule.paymentRef ?? schedule.batchRef}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const submit = async () => {
    setBusy(true);
    try {
      await declare({ batchId, partnerRef: ref });
      toast.success("Reference recorded", {
        description: `We'll mark this paid as soon as ${partnerName} confirms it.`,
      });
      setRef("");
      onDone?.();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmed = schedule.status === "successful";
  const waiting = schedule.status === "processing";

  return (
    <div className="pen-card space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold tracking-tight">Remit through {partnerName}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {monthName(schedule.month)} {schedule.year} · {schedule.rows.length} employees ·{" "}
            <strong>{fmtNaira(schedule.amountKobo)}</strong> · Penroute ref {schedule.paymentRef}
          </p>
        </div>
        <StatusPill status={confirmed ? "successful" : waiting ? "processing" : "initiated"} pulse={!confirmed} />
      </div>

      {confirmed ? (
        <p className="flex items-center gap-2 text-sm text-[#04593A]">
          <ShieldCheck className="size-4" /> {partnerName} confirmed this remittance (ref {schedule.partnerRef}).
        </p>
      ) : (
        <>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-[#2A3B44]">
            <li>Download the schedule Penroute prepared (RSA PINs and PFAs already checked).</li>
            <li>
              Upload it and pay {fmtNaira(schedule.amountKobo)} on {partnerName}'s platform
              {portalUrl ? "" : " (use the link your administrator shared)"}.
            </li>
            <li>Enter the payment or receipt reference {partnerName} gives you.</li>
          </ol>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={downloadCsv}>
              <Download className="size-4" /> Download schedule (CSV)
            </Button>
            {portalUrl && (
              <Button variant="outline" onClick={() => window.open(portalUrl, "_blank", "noopener")}>
                <ExternalLink className="size-4" /> Open {partnerName}
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-64">
              <Label htmlFor="partner-ref">{partnerName} payment reference</Label>
              <Input
                id="partner-ref"
                className="mt-1.5"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder={schedule.partnerRef ?? "e.g. RRR 2803-4411-2290"}
              />
            </div>
            <Button className="font-semibold" disabled={busy || ref.trim().length < 4} onClick={() => void submit()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {waiting ? "Update reference" : "I've paid — record reference"}
            </Button>
          </div>
          {waiting && (
            <p className="text-xs text-[#7A5A10]">
              Reference {schedule.partnerRef} recorded. Waiting for {partnerName} to confirm — this
              is not shown as paid until they do.
            </p>
          )}
        </>
      )}
    </div>
  );
}
