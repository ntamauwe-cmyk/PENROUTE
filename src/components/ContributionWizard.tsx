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
import { Info, Landmark, Loader2, ShieldCheck, TriangleAlert, Upload } from "lucide-react";
import { toast } from "sonner";
import { fmtNaira, monthName, statusLabel } from "@/lib/pension";
import { prePaymentChecks, statutoryContribution } from "@/lib/compliance";
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
          paymentStatus: string;
          settlementStatus: string;
          pfaStatus: string;
          reconciliationStatus: string;
        };
      }
    | undefined;

  const roster = useQuery(api.contributions.getReadyEmployees, { year, month });
  const pfasQuery = useQuery(api.pension.listPfas);
  const pfas = useMemo(() => pfasQuery ?? [], [pfasQuery]);
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

  // Server-computed pricing quote from the central pricing engine — the rate
  // is never hard-coded in the UI.
  const previewPostings = Math.max(uploadedRows?.length ?? roster?.employees?.length ?? 0, 1);
  const feeQuote = useQuery(api.pricing.getQuote, { postings: previewPostings });

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
      setAmounts({});
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

  // ---- Contribution amounts: NEVER a placeholder. Each row's default is,
  // in order: the uploaded file → this period's existing batch → the
  // statutory 8% / 10% of the employee's monthly emoluments → the amount
  // paid last month. Rows with none of these must be entered by hand.
  type Row = {
    key: string;
    fullName: string;
    employeeCode: string;
    pensionPin: string;
    pfaCode: string;
    pfaName: string;
    emolumentKobo: number | null;
    defaultEmployee: number; // naira
    defaultEmployer: number;
    source: "file" | "existing" | "statutory" | "last_month" | "none";
  };
  const previous = useQuery(api.compliance.getPreviousSchedule, { year, month });
  const prevByPin = useMemo(
    () => new Map((previous?.rows ?? []).map((r) => [r.pensionPin, r])),
    [previous],
  );
  const rows: Row[] = useMemo(() => {
    const pfaNameByCode = new Map(pfas.map((p) => [p.code, p.name]));
    if (uploadedRows) {
      return uploadedRows.map((r, i) => ({
        key: `${r.pensionPin}-${i}`,
        fullName: r.fullName,
        employeeCode: r.employeeCode,
        pensionPin: r.pensionPin.toUpperCase().replace(/\s/g, ""),
        pfaCode: r.pfaCode,
        pfaName: pfaNameByCode.get(r.pfaCode) ?? `Unknown PFA (${r.pfaCode})`,
        emolumentKobo: null,
        defaultEmployee: r.employeeContribution,
        defaultEmployer: r.employerContribution,
        source: "file" as const,
      }));
    }
    return employees.map((e) => {
      const base = {
        key: e._id as string,
        fullName: e.fullName,
        employeeCode: e.employeeCode,
        pensionPin: e.pensionPin,
        pfaCode: pfaCodeById.get(e.pfaId) ?? "",
        pfaName: pfaNameById.get(e.pfaId) ?? "PFA",
        emolumentKobo: e.monthlyEmolumentKobo ?? null,
      };
      if (e.record) {
        return { ...base, defaultEmployee: e.record.employeeContribution / 100, defaultEmployer: e.record.employerContribution / 100, source: "existing" as const };
      }
      if (e.monthlyEmolumentKobo) {
        const st = statutoryContribution(e.monthlyEmolumentKobo);
        return { ...base, defaultEmployee: st.employeeKobo / 100, defaultEmployer: st.employerKobo / 100, source: "statutory" as const };
      }
      const last = prevByPin.get(e.pensionPin);
      if (last) {
        return { ...base, defaultEmployee: last.employeeKobo / 100, defaultEmployer: last.employerKobo / 100, source: "last_month" as const };
      }
      return { ...base, defaultEmployee: 0, defaultEmployer: 0, source: "none" as const };
    });
  }, [uploadedRows, employees, pfas, pfaCodeById, pfaNameById, prevByPin]);

  const amountFor = (r: Row) => amounts[r.key] ?? { employee: r.defaultEmployee, employer: r.defaultEmployer };

  const prepared = rows.map((r) => ({
    fullName: r.fullName,
    employeeCode: r.employeeCode,
    pensionPin: r.pensionPin,
    pfaCode: r.pfaCode,
    employeeContribution: amountFor(r).employee,
    employerContribution: amountFor(r).employer,
  }));
  const totalRecords = prepared.length;
  const employeeSumN = prepared.reduce((s, r) => s + r.employeeContribution, 0);
  const employerSumN = prepared.reduce((s, r) => s + r.employerContribution, 0);
  const pensionTotalN = employeeSumN + employerSumN;
  // Pricing engine: per-posting rate comes from the server-side quote
  // (admin-configured tiers) — never a hard-coded number.
  const feePerEmployeeN = (feeQuote?.feePerPostingKobo ?? 0) / 100;
  const feeN = totalRecords * feePerEmployeeN;

  // Pre-payment checks against the statutory minimums and last month.
  const findings = useMemo(
    () =>
      prePaymentChecks(
        rows.map((r) => ({
          key: r.key,
          fullName: r.fullName,
          pensionPin: r.pensionPin,
          pfaCode: r.pfaCode,
          employeeKobo: Math.round(amountFor(r).employee * 100),
          employerKobo: Math.round(amountFor(r).employer * 100),
          emolumentKobo: r.emolumentKobo,
        })),
        previous?.rows ?? null,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, amounts, previous],
  );
  const blocking = findings.filter((f) => f.level === "block");

  // PFA distribution preview (step 04) — from the rows actually being paid.
  const pfaDist = useMemo(() => {
    const map = new Map<string, { name: string; count: number; total: number }>();
    for (const r of rows) {
      const a = amountFor(r);
      const g = map.get(r.pfaCode) ?? { name: r.pfaName, count: 0, total: 0 };
      g.count += 1;
      g.total += a.employee + a.employer;
      map.set(r.pfaCode, g);
    }
    return [...map.entries()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, amounts]);

  const prepare = useMutation(api.engine.prepareBatch);
  const pay = useMutation(api.engine.payBatch);
  const pipeline = useMutation(api.engine.resumePipeline);

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
          // Payment is verified; settlement, PFA posting and reconciliation are
          // separate stages that confirm on their own — never claim them here.
          toast.success("Payment verified by Paystack", {
            description: dispatched
              ? "Contributions are being delivered to the PFAs — this page updates live."
              : `${monthName(month)} ${year} · ${totalRecords} employees · processing`,
          });
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
              Payment: {statusLabel(b.paymentStatus)}
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
                {rows.map((r) => {
                  const a = amountFor(r);
                  const hint =
                    r.source === "statutory" && r.emolumentKobo
                      ? `8% / 10% of ${fmtNaira(r.emolumentKobo, { noKobo: true })}`
                      : r.source === "last_month"
                        ? `Same as ${previous?.period ?? "last month"}`
                        : r.source === "existing"
                          ? "From this period's schedule"
                          : r.source === "file"
                            ? "From uploaded file"
                            : "Enter amounts";
                  const setPart = (part: "employee" | "employer", value: number) =>
                    setAmounts((p) => ({ ...p, [r.key]: { ...a, [part]: value } }));
                  return (
                    <tr key={r.key} className="border-t border-[#EDF0F2]">
                      <td className="px-2 py-2">
                        <p className="font-medium text-[#0B1F2A]">{r.fullName}</p>
                        <p className={`text-[11px] ${r.source === "none" ? "font-semibold text-[#C4453C]" : "text-[#8299A5]"}`}>
                          {hint}
                        </p>
                      </td>
                      <td className="px-2 py-2 tabular-nums text-[#5A6B74]">{r.pensionPin}</td>
                      <td className="hidden px-2 py-2 text-[#5A6B74] sm:table-cell">{r.pfaName}</td>
                      <td className="px-2 py-1 text-right">
                        <Input
                          type="number"
                          aria-label={`Employee contribution for ${r.fullName}`}
                          className="ml-auto h-8 w-28 text-right tabular-nums"
                          value={a.employee}
                          min={0}
                          step="0.01"
                          disabled={paying}
                          onChange={(ev) => setPart("employee", Math.max(0, Number(ev.target.value) || 0))}
                        />
                      </td>
                      <td className="px-2 py-1 text-right">
                        <Input
                          type="number"
                          aria-label={`Employer contribution for ${r.fullName}`}
                          className="ml-auto h-8 w-28 text-right tabular-nums"
                          value={a.employer}
                          min={0}
                          step="0.01"
                          disabled={paying}
                          onChange={(ev) => setPart("employer", Math.max(0, Number(ev.target.value) || 0))}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollArea>

          {/* Pre-payment checks */}
          {findings.length > 0 && (
            <div className="mt-4 rounded-xl border border-[#E5E9EC] p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-[#5A6B74]">
                Pre-payment checks{previous ? ` · compared with ${previous.period}` : ""}
              </p>
              <ul className="mt-2 max-h-40 space-y-1.5 overflow-y-auto text-sm">
                {findings.map((f, i) => (
                  <li key={i} className="flex items-start gap-2">
                    {f.level === "info" ? (
                      <Info className="mt-0.5 size-4 shrink-0 text-[#5A6B74]" />
                    ) : (
                      <TriangleAlert
                        className={`mt-0.5 size-4 shrink-0 ${f.level === "block" ? "text-[#C4453C]" : "text-[#B8860B]"}`}
                      />
                    )}
                    <span className={f.level === "block" ? "font-medium text-[#8A2F28]" : "text-[#2A3B44]"}>
                      {f.message}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Payment summary + authorise */}
          <div className="mt-5 flex flex-col gap-4 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm">
              <p className="font-semibold text-[#0B1F2A]">
                Penroute processing fee: {fmtNaira(feeN * 100)}{" "}
                <span className="font-normal text-[#5A6B74]">
                  ({totalRecords} × ₦{feePerEmployeeN % 1 === 0 ? feePerEmployeeN : feePerEmployeeN.toFixed(2)}
                  {feeQuote ? ` · ${feeQuote.tierLabel}` : ""})
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
              disabled={paying || totalRecords === 0 || blocking.length > 0}
              title={blocking.length > 0 ? "Fix the rows marked in red before paying" : undefined}
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
