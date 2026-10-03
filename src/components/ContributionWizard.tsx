import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Landmark, Loader2, ShieldCheck, Upload } from "lucide-react";
import { toast } from "sonner";
import { fmtNaira, monthName, statusLabel } from "@/lib/pension";
import { LivePaymentPanel } from "@/components/LivePaymentPanel";

interface Props {
  onDone: (batchId: Id<"contributionBatches">) => void;
}

const WIZARD_STEPS = [
  "Period",
  "Employees",
  "Contributions",
  "PFA Distribution",
  "Review",
  "Authorise",
] as const;

/**
 * New Pension Payment wizard (Penroute): select period → validated employees →
 * contributions → PFA distribution → review → authorise ONE consolidated payment.
 * Engine calls are unchanged (idempotent prepare → pay → pipeline).
 */
export function ContributionWizard({ onDone }: Props) {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const [month, setMonth] = useState<number>(prev.getMonth() + 1);
  const [year, setYear] = useState<number>(prev.getFullYear());
  const [step, setStep] = useState<"period" | "review" | "done">("period");
  const [amounts, setAmounts] = useState<Record<string, { employee: number; employer: number }>>({});
  const [paying, setPaying] = useState(false);
  // The completed batch — its live status drives the done screen in real time.
  const [finishedBatchId, setFinishedBatchId] = useState<Id<"contributionBatches"> | null>(null);
  const finished = useQuery(
    api.pension.getBatchDetail,
    finishedBatchId ? { batchId: finishedBatchId } : "skip",
  ) as
    | {
        batch: {
          status: string;
          settlementStatus: string;
          pfaStatus: string;
          reconciliationStatus: string;
        };
      }
    | undefined;

  const roster = useQuery(api.contributions.getReadyEmployees, { year, month });
  const pfas = useQuery(api.pension.listPfas) ?? [];
  const feeConfig = useQuery(api.pension.getFeeConfig);
  const pfaCodeById = useMemo(() => new Map(pfas.map((p) => [p._id, p.code])), [pfas]);
  const pfaNameById = useMemo(() => new Map(pfas.map((p) => [p._id, p.name])), [pfas]);

  const employees = roster?.employees ?? [];
  const existingBatch = roster?.existingBatch ?? null;

  // ---- CSV schedule upload (spec §7: "Generate or upload a monthly schedule") ----
  // Accepts: Full name, Employee ID, Pension PIN, PFA code, Employee amount, Employer amount
  const [uploadedRows, setUploadedRows] = useState<
    { fullName: string; employeeCode: string; pensionPin: string; pfaCode: string; employeeContribution: number; employerContribution: number }[]
  | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const parseScheduleCsv = (text: string) => {
    setUploadError(null);
    try {
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) throw new Error("The file needs a header row and at least one employee row.");
      const split = (line: string) =>
        line.includes(";") && !line.includes(",") ? line.split(";") : line.split(",");
      const header = split(lines[0]).map((h) => h.trim().toLowerCase().replace(/["\uFEFF]/g, ""));
      const idx = (...names: string[]) => header.findIndex((h) => names.includes(h));
      const iName = idx("full name", "fullname", "name");
      const iCode = idx("employee id", "employeeid", "employee code", "staff id");
      const iPin = idx("pension pin", "pensionpin", "pin", "rsa pin");
      const iPfa = idx("pfa code", "pfacode", "pfa");
      const iEmp = idx("employee contribution", "employeecontribution", "employee amount");
      const iEr = idx("employer contribution", "employercontribution", "employer amount");
      if (iName < 0 || iPin < 0 || iPfa < 0 || iEmp < 0 || iEr < 0) {
        throw new Error(
          "Missing required columns. Expected: Full name, Pension PIN, PFA code, Employee contribution, Employer contribution (Employee ID optional).",
        );
      }
      const rows = lines.slice(1).map((line, n) => {
        const c = split(line).map((v) => v.trim().replace(/"/g, ""));
        const employeeContribution = Number((c[iEmp] ?? "").replace(/[₦,\s]/g, ""));
        const employerContribution = Number((c[iEr] ?? "").replace(/[₦,\s]/g, ""));
        if (!Number.isFinite(employeeContribution) || !Number.isFinite(employerContribution)) {
          throw new Error(`Row ${n + 2}: contribution amounts must be numbers (naira).`);
        }
        return {
          fullName: c[iName] ?? "",
          employeeCode: iCode >= 0 ? (c[iCode] ?? "") : `CSV-${n + 1}`,
          pensionPin: c[iPin] ?? "",
          pfaCode: c[iPfa] ?? "",
          employeeContribution,
          employerContribution,
        };
      });
      if (rows.length === 0) throw new Error("No employee rows found in the file.");
      setUploadedRows(rows);
      setAmounts(
        Object.fromEntries(rows.map((r) => [r.employeeCode, { employee: r.employeeContribution, employer: r.employerContribution }])),
      );
      toast.success(`Schedule loaded — ${rows.length} employees from CSV`);
    } catch (e) {
      setUploadedRows(null);
      setUploadError(e instanceof Error ? e.message : "Could not read the file");
    }
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => parseScheduleCsv(String(reader.result ?? ""));
    reader.onerror = () => setUploadError("Could not read the file");
    reader.readAsText(file);
    e.target.value = "";
  };

  const clearUpload = () => {
    setUploadedRows(null);
    setUploadError(null);
    setAmounts({});
  };

  const amountFor = (code: string) => amounts[code] ?? { employee: 25000, employer: 25000 };

  const prepared: {
    fullName: string;
    employeeCode: string;
    pensionPin: string;
    pfaCode: string;
    employeeContribution: number;
    employerContribution: number;
  }[] = uploadedRows
    ? uploadedRows
    : employees.map((e) => ({
        fullName: e.fullName,
        employeeCode: e.employeeCode,
        pensionPin: e.pensionPin,
        pfaCode: pfaCodeById.get(e.pfaId) ?? "",
        employeeContribution: amountFor(e.employeeCode).employee,
        employerContribution: amountFor(e.employeeCode).employer,
      }));
  const totalRecords = prepared.length;
  const employeeSumN = prepared.reduce((s, r) => s + r.employeeContribution, 0);
  const employerSumN = prepared.reduce((s, r) => s + r.employerContribution, 0);
  const pensionTotalN = employeeSumN + employerSumN;
  // Fee Engine: the per-employee fee is admin-configurable (never hard-coded).
  // While the config loads, mirror the ₦9 default so the preview stays honest.
  const feePerEmployeeN = (feeConfig ?? 900) / 100;
  const feeN = totalRecords * feePerEmployeeN;

  // PFA distribution preview (step 04) — computed from the validated roster
  const pfaDist = useMemo(() => {
    const map = new Map<Id<"pfas">, { name: string; count: number; total: number }>();
    for (const e of employees) {
      const a = amountFor(e.employeeCode);
      const g = map.get(e.pfaId) ?? { name: pfaNameById.get(e.pfaId) ?? "PFA", count: 0, total: 0 };
      g.count += 1;
      g.total += a.employee + a.employer;
      map.set(e.pfaId, g);
    }
    return [...map.entries()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees, amounts, pfaNameById]);

  const prepare = useMutation(api.engine.prepareBatch);
  const pay = useMutation(api.engine.payBatch);
  const pipeline = useMutation(api.engine.processPipeline);

  // Live-rail state: when the platform rail is "live", payBatch returns a
  // checkout handoff instead of settling instantly.
  const [checkout, setCheckout] = useState<{
    batchId: Id<"contributionBatches">;
    amountKobo: number;
    payerEmail: string;
  } | null>(null);

  const authorise = async () => {
    setPaying(true);
    try {
      // Idempotent: if the exact batch already exists, prepareBatch returns it
      // and pay/process run against it instead of duplicating money movement.
      const res = await prepare({ year, month, records: prepared });
      const bId = res.batchId as Id<"contributionBatches">;
      const payRes = await pay({ batchId: bId });
      if ("requiresCheckout" in payRes && payRes.requiresCheckout) {
        // LIVE RAIL: stop here — LivePaymentPanel takes over (init + verify + finalize)
        setCheckout({
          batchId: bId,
          amountKobo: payRes.amountKobo,
          payerEmail: payRes.payerEmail,
        });
        setPaying(false);
        return;
      }
      await pipeline({ batchId: bId });
      // Dispatched batches: live-PFA delivery is scheduled server-side and the
      // dashboard shows the live status — never claim "reconciled & posted" here.
      toast.success("Payment authorised — processing contributions", {
        description: `${monthName(month)} ${year} · ${totalRecords} employees`,
      });
      setStep("done");
      setFinishedBatchId(bId);
      onDone(bId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Payment failed";
      toast.error(msg);
      if (msg.includes("not payable")) {
        setStep("period");
      }
    } finally {
      setPaying(false);
    }
  };

  if (checkout) {
    return (
      <LivePaymentPanel
        batchId={checkout.batchId}
        amountKobo={checkout.amountKobo}
        payerEmail={checkout.payerEmail}
        onPaid={async () => {
          let dispatched = false;
          try {
            const res = await pipeline({ batchId: checkout.batchId });
            dispatched =
              typeof res === "object" && res !== null && "dispatched" in res
                ? Boolean((res as { dispatched?: boolean }).dispatched)
                : false;
          } catch {
            /* pipeline can also be resumed from the dashboard */
          }
          if (dispatched) {
            toast.info("Payment verified — contributions are being delivered to the PFAs", {
              description: "This page updates live as each PFA acknowledges and posts.",
            });
          } else {
            toast.success("Pension payment completed", {
              description: `${monthName(month)} ${year} · ${totalRecords} employees · reconciled & posted`,
            });
          }
          setStep("done");
          setFinishedBatchId(checkout.batchId);
          onDone(checkout.batchId);
        }}
      />
    );
  }

  if (step === "done" && finishedBatchId) {
    const b = finished?.batch;
    const fullyDone = b?.status === "completed";
    return (
      <div className="pen-card-lg p-7 sm:p-8 text-center">
        <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-[#E6F6EF]">
          {fullyDone ? (
            <ShieldCheck className="size-7 text-[#007A4D]" />
          ) : (
            <Loader2 className="size-7 animate-spin text-[#007A4D]" />
          )}
        </span>
        <h3 className="mt-4 text-xl font-bold tracking-tight text-[#0B1F2A]">
          {fullyDone ? "PENSION PAYMENT COMPLETED" : "PENSION PAYMENT PROCESSING"}
        </h3>
        <p className="mt-2 text-sm text-[#5A6B74]">
          {monthName(month)} {year} · {totalRecords} employees
          {b ? ` · ${statusLabel(b.status)}` : " · processing"}
        </p>
        {b && (
          <div className="mx-auto mt-4 flex max-w-md flex-wrap justify-center gap-2">
            <Badge variant="outline" className="font-medium">
              Payment: {statusLabel("successful")}
            </Badge>
            <Badge variant="outline" className="font-medium">
              Settlement: {statusLabel(b.settlementStatus)}
            </Badge>
            <Badge variant="outline" className="font-medium">
              PFA: {statusLabel(b.pfaStatus)}
            </Badge>
            <Badge variant="outline" className="font-medium">
              Reconciliation: {statusLabel(b.reconciliationStatus)}
            </Badge>
          </div>
        )}
        <p className="mt-4 text-xs text-[#8299A5]">
          {fullyDone
            ? "All allocations settled, acknowledged by the PFAs and reconciled. Your receipt is shown below."
            : "Allocation, PFA delivery and reconciliation run automatically — this page updates live as each stage confirms. Your receipt is shown below."}
        </p>
      </div>
    );
  }

  const stepIndex = step === "period" ? 0 : 4;

  return (
    <div className="space-y-6">
      {/* Penroute numbered progress: 01 Period … 06 Authorise */}
      <div className="pen-card p-4 shadow-[0_1px_2px_rgb(11_31_42_/_0.03)]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
          {WIZARD_STEPS.map((s, i) => {
            const reached = i <= stepIndex + (step === "review" ? 1 : 0);
            const current = i === stepIndex;
            return (
              <div key={s} className="flex items-center gap-2">
                <span
                  className={`pill ${current ? "st-green" : reached ? "st-slate" : "st-slate"}`}
                  style={current ? { outline: "1.5px solid #00C896", outlineOffset: 1 } : undefined}
                >
                  <span className="font-bold">{String(i + 1).padStart(2, "0")}</span>
                  {s}
                </span>
                {i < WIZARD_STEPS.length - 1 && (
                  <span className="hidden text-[#8299A5] md:inline">→</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {step === "period" && (
        <div className="pen-card-lg p-6 sm:p-7">
          <h3 className="font-bold tracking-tight text-[#0B1F2A]">01 · Contribution period</h3>
          <p className="mt-0.5 text-sm text-[#5A6B74]">
            Select the month this pension contribution is for.
          </p>
          <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Label className="text-xs font-bold uppercase tracking-wide text-[#0B1F2A]">
                Contribution month
              </Label>
              <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
                <SelectTrigger className="mt-2 w-full cursor-pointer">
                  <SelectValue placeholder="Select month" />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <SelectItem key={m} value={String(m)}>{monthName(m)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1">
              <Label className="text-xs font-bold uppercase tracking-wide text-[#0B1F2A]">
                Contribution year
              </Label>
              <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                <SelectTrigger className="mt-2 w-full cursor-pointer">
                  <SelectValue placeholder="Select year" />
                </SelectTrigger>
                <SelectContent>
                  {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map((y) => (
                    <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              className="bg-[#007A4D] font-semibold hover:bg-[#006A43]"
              onClick={() => setStep("review")}
              disabled={totalRecords === 0 || existingBatch?.status === "completed"}
            >
              Continue
              {totalRecords > 0 && (
                <Badge variant="secondary" className="ml-1.5">{totalRecords}</Badge>
              )}
            </Button>
          </div>

          {/* 02 · Employees — roster or CSV schedule upload */}
          <div className="pen-inset mt-5 p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-[#0B1F2A]">
                  02 · Employees — {totalRecords} with validated pension details
                </p>
                <p className="mt-0.5 text-xs text-[#5A6B74]">
                  {uploadedRows
                    ? "Using your uploaded schedule — amounts are editable in the review step."
                    : "Using your saved roster. Every record is checked (pension PIN, PFA, duplicates, amounts) before payment."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {uploadedRows && (
                  <Button size="sm" variant="ghost" onClick={clearUpload}>
                    Use roster instead
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="border-[#0B1F2A]/15 font-semibold text-[#0B1F2A]"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="size-4" />
                  {uploadedRows ? "Replace CSV" : "Upload CSV schedule"}
                </Button>
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              className="hidden"
              onChange={handleFile}
            />
            {uploadError && (
              <p className="mt-3 text-xs font-medium text-[#C4453C]">{uploadError}</p>
            )}
            {uploadedRows && !uploadError && (
              <p className="mt-3 text-xs font-medium text-[#04593A]">
                ✓ {uploadedRows.length} employees loaded from the schedule file.
              </p>
            )}
          </div>
          {existingBatch?.status === "completed" && (
            <p className="mt-3 text-xs font-medium text-[#04593A]">
              ✓ {monthName(month)} {year} is already paid and completed. Pick another month for a
              new contribution.
            </p>
          )}
          {existingBatch && existingBatch.status !== "completed" && (
            <p className="mt-3 text-xs font-medium text-[#7A5A10]">
              A batch for {monthName(month)} {year} already exists (
              {statusLabel(existingBatch.status)}). It will be reused — idempotency prevents
              duplicate payment.
            </p>
          )}
          {totalRecords === 0 && !roster && (
            <p className="mt-3 text-xs text-[#8299A5]">Loading employee roster…</p>
          )}
        </div>
      )}

      {step === "review" && (
        <div className="pen-card-lg p-6 sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-bold tracking-tight text-[#0B1F2A]">
                Review — {monthName(month)} {year}
              </h3>
              <p className="text-sm text-[#5A6B74]">
                03 · Contributions per employee · 04 · PFA distribution · 05 · Summary
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="font-semibold text-[#0B1F2A]"
              onClick={() => setStep("period")}
            >
              ← Back
            </Button>
          </div>

          {/* Contribution summary tiles */}
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ["Employees", String(totalRecords)],
              ["Employee contributions", fmtNaira(employeeSumN * 100)],
              ["Employer contributions", fmtNaira(employerSumN * 100)],
              ["Total pension", fmtNaira(pensionTotalN * 100)],
            ].map(([k, v]) => (
              <div key={k} className="pen-inset p-4">
                <p className="text-xs font-medium text-[#5A6B74]">{k}</p>
                <p className="mt-1 text-xl font-bold tabular-nums text-[#0B1F2A]">{v}</p>
              </div>
            ))}
          </div>

          {/* 04 · PFA distribution */}
          <div className="mt-4">
            <p className="text-xs font-bold uppercase tracking-wide text-[#5A6B74]">
              04 · PFA distribution
            </p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {pfaDist.map(([id, g]) => (
                <div key={id} className="pen-tile p-3.5">
                  <div className="flex items-center gap-2">
                    <Landmark className="size-4 text-[#007A4D]" />
                    <p className="truncate text-sm font-semibold text-[#0B1F2A]">{g.name}</p>
                  </div>
                  <p className="mt-1.5 text-base font-bold tabular-nums text-[#0B1F2A]">
                    {fmtNaira(g.total * 100)}
                  </p>
                  <p className="text-xs text-[#5A6B74]">{g.count} employees</p>
                </div>
              ))}
            </div>
          </div>

          {/* Roster with editable amounts */}
          <ScrollArea className="pen-inset mt-4 max-h-72 p-2">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white">
                <tr className="text-left text-[11px] uppercase tracking-wide text-[#5A6B74]">
                  <th className="px-2 py-2 font-semibold">Employee</th>
                  <th className="px-2 py-2 font-semibold">Pension PIN</th>
                  <th className="hidden px-2 py-2 font-semibold sm:table-cell">PFA</th>
                  <th className="px-2 py-2 text-right font-semibold">Employee ₦</th>
                  <th className="px-2 py-2 text-right font-semibold">Employer ₦</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => {
                  const a = amountFor(e.employeeCode);
                  return (
                    <tr key={e._id} className="border-t border-[#EDF0F2]">
                      <td className="px-2 py-2 font-medium text-[#0B1F2A]">{e.fullName}</td>
                      <td className="px-2 py-2 tabular-nums text-[#5A6B74]">{e.pensionPin}</td>
                      <td className="hidden px-2 py-2 text-[#5A6B74] sm:table-cell">
                        {pfaNameById.get(e.pfaId) ?? "—"}
                      </td>
                      <td className="px-2 py-1 text-right">
                        <Input
                          type="number"
                          className="ml-auto h-8 w-28 text-right tabular-nums"
                          value={a.employee}
                          min={0}
                          disabled={paying}
                          onChange={(ev) =>
                            setAmounts((p) => ({
                              ...p,
                              [e.employeeCode]: { ...a, employee: Number(ev.target.value) || 0 },
                            }))
                          }
                        />
                      </td>
                      <td className="px-2 py-1 text-right">
                        <Input
                          type="number"
                          className="ml-auto h-8 w-28 text-right tabular-nums"
                          value={a.employer}
                          min={0}
                          disabled={paying}
                          onChange={(ev) =>
                            setAmounts((p) => ({
                              ...p,
                              [e.employeeCode]: { ...a, employer: Number(ev.target.value) || 0 },
                            }))
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollArea>

          {/* Payment summary + authorise */}
          <div className="mt-5 flex flex-col gap-4 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm">
              <p className="font-semibold text-[#0B1F2A]">
                Penroute fee: {fmtNaira(feeN * 100)}{" "}
                <span className="font-normal text-[#5A6B74]">
                  ({totalRecords} × ₦{feePerEmployeeN % 1 === 0 ? feePerEmployeeN : feePerEmployeeN.toFixed(2)})
                </span>
              </p>
              <p className="text-lg font-bold tabular-nums text-[#0B1F2A]">
                Total payable: {fmtNaira((pensionTotalN + feeN) * 100)}
              </p>
            </div>
            <Button
              size="lg"
              className="bg-[#007A4D] px-7 font-semibold hover:bg-[#006A43]"
              onClick={authorise}
              disabled={paying || totalRecords === 0}
            >
              {paying ? (
                <>
                  <Loader2 className="size-5 animate-spin" /> Processing payment…
                </>
              ) : (
                <>
                  <ShieldCheck className="size-5" /> Authorise Payment
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
