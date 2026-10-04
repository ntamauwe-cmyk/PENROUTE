import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PaymentReceipt } from "@/components/PaymentCertificate";
import { ContributionWizard } from "@/components/ContributionWizard";
import { DashboardShell } from "@/components/DashboardShell";
import { LoadingBlock, StatTile, StatusPill, useEmployer } from "@/components/pension-ui";
import {
  CheckCircle2,
  FileText,
  Landmark,
  Plus,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import {
  CYCLE_STAGES,
  cycleStageIndex,
  fmtDate,
  fmtNaira,
  greetingNow,
  monthName,
} from "@/lib/pension";

export default function Overview() {
  const { dash, employer, batches, loading, needsSeed } = useEmployer();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardTick, setWizardTick] = useState(0);
  const [receiptBatchId, setReceiptBatchId] = useState<Id<"contributionBatches"> | null>(null);

  const pfasQuery = useQuery(api.pension.listPfas);
  const pfas = useMemo(() => pfasQuery ?? [], [pfasQuery]);
  const detail = useQuery(
    api.pension.getBatchDetail,
    receiptBatchId ? { batchId: receiptBatchId } : "skip",
  );
  const seed = useMutation(api.pension.seedDemoData);
  const claim = useMutation(api.pension.claimDemoEmployer);
  const syncPfas = useMutation(api.pension.syncPfaDirectory);
  const [seeding, setSeeding] = useState(false);

  const latest = batches[0] ?? null;
  const pfaNameById = useMemo(() => new Map(pfas.map((p) => [p._id, p.name])), [pfas]);
  const stats = dash?.stats ?? { completed: 0, processing: 0, failed: 0 };
  const pendingTotal = batches
    .filter((b) => b.status === "awaiting_payment" || b.status === "processing")
    .reduce((s, b) => s + b.totalDebit, 0);

  const ensureSeed = async () => {
    setSeeding(true);
    try {
      await seed({});
      await claim({});
      // Keep the PFA directory complete even on pre-existing workspaces.
      await syncPfas({});
      toast.success("Demo workspace loaded");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Seeding failed");
    } finally {
      setSeeding(false);
    }
  };

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <LoadingBlock label="Loading your workspace…" />
      </main>
    );
  }

  if (needsSeed) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="pen-card-lg max-w-md p-8 text-center">
          <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-[#E6F6EF]">
            <Landmark className="size-7 text-[#007A4D]" />
          </span>
          <h1 className="mt-4 text-xl font-bold tracking-tight text-[#0B1F2A]">
            Welcome to Penroute
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-[#5A6B74]">
            Load the demo employer (Rae Technologies Limited) with 24 employees across 4 PFAs to
            explore the platform.
          </p>
          <Button
            className="mt-6 w-full bg-[#007A4D] font-semibold hover:bg-[#006A43]"
            onClick={ensureSeed}
            disabled={seeding}
          >
            {seeding ? <RefreshCw className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Load demo workspace
          </Button>
        </div>
      </main>
    );
  }

  const stageIdx = latest ? cycleStageIndex(latest) : -1;
  const firstName = employer?.name?.split(" ")[0] ?? "Employer";
  const greeting = greetingNow();

  return (
    <DashboardShell>
      {/* ===== Header ===== */}
      <div className="pen-page-header">
        <div>
          <p className="pen-eyebrow">Employer workspace</p>
          <h1 className="pen-page-title">
            {greeting}, {firstName}
          </h1>
          <p className="pen-page-description">Here's your pension payment overview.</p>
        </div>
        <div className="flex flex-wrap gap-2 no-print">
          <Button
            className="bg-[#007A4D] font-semibold hover:bg-[#006A43]"
            onClick={() => setWizardOpen(true)}
          >
            <Wallet className="size-4" /> Make Payment
          </Button>
          <Button
            variant="outline"
            className="border-[#0B1F2A]/15 font-semibold text-[#0B1F2A]"
            onClick={() => (window.location.href = "/dashboard/employees")}
          >
            Add Employee
          </Button>
        </div>
      </div>

      {/* ===== THE SCREEN: real-time pension payment status ===== */}
      {latest ? (
        <section className="pen-card-lg p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#5A6B74]">
                Pension payment status · live
              </p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight text-[#0B1F2A] sm:text-3xl">
                {monthName(latest.contributionMonth)} {latest.contributionYear}
              </h2>
              <p className="mt-1 text-sm text-[#5A6B74]">
                Batch {latest.batchRef} · Paid {fmtDate(latest.paymentDate)}
                {latest.paymentRef ? ` · Ref ${latest.paymentRef}` : ""}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs font-semibold uppercase tracking-wide text-[#5A6B74]">
                Total pension contribution
              </p>
              <p className="mt-1 text-3xl font-bold tabular-nums text-[#0B1F2A] sm:text-4xl">
                {fmtNaira(latest.totalPensionAmount)}
              </p>
              <div className="mt-2">
                <StatusPill status={latest.status} pulse={latest.status === "processing"} />
              </div>
            </div>
          </div>

          {/* Cycle tracker */}
          <div className="pen-inset mt-6 p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {CYCLE_STAGES.map((s, i) => {
                const done = i < stageIdx;
                const active = i === stageIdx;
                return (
                  <div key={s} className="flex items-center gap-2">
                    <span className={`pill ${done ? "st-green" : active ? "st-blue" : "st-slate"}`}>
                      <span
                        className={`pill-dot ${
                          done ? "" : active ? "pulse-dot" : ""
                        }`}
                      />
                      {s}
                    </span>
                    {i < CYCLE_STAGES.length - 1 && (
                      <span className="hidden text-[#8299A5] sm:inline">→</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* PFA submission status */}
          <div className="mt-5">
            <PfaSubmissionSummary batchId={latest._id} pfaNameById={pfaNameById} />
          </div>

          {/* Actions */}
          <div className="mt-6 flex flex-wrap gap-3 no-print">
            {latest.status === "processing" ? (
              <ResumePipeline batchId={latest._id} />
            ) : (
              <Button
                variant="outline"
                className="border-[#0B1F2A]/15 font-semibold text-[#0B1F2A]"
                disabled={latest.status !== "completed"}
                onClick={() => setReceiptBatchId(latest._id)}
              >
                <FileText className="size-4" />
                {latest.status === "completed"
                  ? "View payment receipt"
                  : "Receipt (available when completed)"}
              </Button>
            )}
          </div>
        </section>
      ) : (
        <section className="pen-card-lg p-8 text-center">
          <h2 className="text-2xl font-bold tracking-tight text-[#0B1F2A]">
            No pension payments yet
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-[#5A6B74]">
            Your pension payments will appear here once you create your first payment.
          </p>
          <Button
            className="mt-5 bg-[#007A4D] font-semibold hover:bg-[#006A43]"
            onClick={() => setWizardOpen(true)}
          >
            <Plus className="size-4" /> Make Your First Payment
          </Button>
        </section>
      )}

      {/* ===== Summary cards ===== */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Total Employees" value={String(dash?.employeeCount ?? 0)} />
        <StatTile
          label="Total Contributions"
          value={fmtNaira(dash?.totalProcessed ?? 0, { compact: true })}
          sub="lifetime pension processed"
        />
        <StatTile
          label="This Month"
          value={latest ? fmtNaira(latest.totalPensionAmount, { compact: true }) : "₦0"}
          sub={latest ? `${monthName(latest.contributionMonth)} ${latest.contributionYear}` : "—"}
        />
        <StatTile
          label="Pending Payment"
          value={fmtNaira(pendingTotal, { compact: true })}
          sub={
            stats.processing + stats.failed > 0
              ? `${stats.processing} processing · ${stats.failed} failed`
              : "nothing outstanding"
          }
        />
      </section>

      {/* ===== Recent pension payments ===== */}
      <section className="pen-card p-5 sm:p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-bold tracking-tight text-[#0B1F2A]">Recent Pension Payments</h2>
          <span className="text-xs text-[#5A6B74]">
            {stats.completed} completed · {stats.processing} processing · {stats.failed} failed
          </span>
        </div>
        <ScrollArea className="mt-3 max-h-96">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="text-left text-[11px] uppercase tracking-wide text-[#5A6B74]">
                <th className="px-2 py-2.5 font-semibold">Date</th>
                <th className="px-2 py-2.5 font-semibold">Payment Reference</th>
                <th className="px-2 py-2.5 text-right font-semibold">Staff Count</th>
                <th className="px-2 py-2.5 text-right font-semibold">Amount</th>
                <th className="hidden px-2 py-2.5 font-semibold sm:table-cell">PFA</th>
                <th className="px-2 py-2.5 font-semibold">Status</th>
                <th className="px-2 py-2.5 text-right font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => {
                // Legacy per-batch PFA list — optional on the doc (may be absent).
                const pfasForBatch = new Set(
                  (b as typeof b & { pfaCodes?: string[] }).pfaCodes ?? [],
                );
                return (
                  <tr key={b._id} className="border-t border-[#EDF0F2]">
                    <td className="px-2 py-2.5 font-medium text-[#0B1F2A]">
                      {fmtDate(b.paymentDate ?? b.createdAt)}
                    </td>
                    <td className="px-2 py-2.5 tabular-nums text-[#5A6B74]">
                      {b.paymentRef ?? b.batchRef}
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums">{b.employeeCount}</td>
                    <td className="px-2 py-2.5 text-right font-semibold tabular-nums text-[#0B1F2A]">
                      {fmtNaira(b.totalDebit)}
                    </td>
                    <td className="hidden px-2 py-2.5 text-[#5A6B74] sm:table-cell">
                      {pfasForBatch.size > 0 ? `${pfasForBatch.size} PFA${pfasForBatch.size > 1 ? "s" : ""}` : "—"}
                    </td>
                    <td className="px-2 py-2.5">
                      <StatusPill status={b.status} />
                    </td>
                    <td className="px-2 py-2.5 text-right">
                      {b.status === "completed" ? (
                        <button
                          className="text-xs font-bold text-[#007A4D] hover:underline"
                          onClick={() => setReceiptBatchId(b._id)}
                        >
                          Receipt
                        </button>
                      ) : (
                        <span className="text-xs text-[#8299A5]">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {batches.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-2 py-8 text-center text-[#5A6B74]">
                    No pension payments yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </ScrollArea>
      </section>

      {/* ===== PFAs receiving contributions ===== */}
      <section className="pen-card p-5 sm:p-6">
        <h2 className="font-bold tracking-tight text-[#0B1F2A]">
          PFAs receiving contributions
        </h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {pfas.map((p) => (
            <div key={p._id} className="pen-tile p-4">
              <div className="flex items-center gap-2">
                <Landmark className="size-4 text-[#007A4D]" />
                <p className="truncate text-sm font-semibold text-[#0B1F2A]">{p.name}</p>
              </div>
              <p className="mt-1 text-xs text-[#5A6B74]">PFA code {p.code}</p>
              <span className="pill st-slate mt-2">
                <span className="pill-dot" />
                {p.integrationMode === "sandbox_adapter" ? "Sandbox adapter" : "Live integration"}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ===== New payment wizard ===== */}
      <Dialog open={wizardOpen} onOpenChange={setWizardOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-auto">
          <DialogHeader>
            <DialogTitle className="text-[#0B1F2A]">New Pension Payment</DialogTitle>
            <DialogDescription>
              Select the contribution period, review the validated employees and authorise one
              consolidated payment.
            </DialogDescription>
          </DialogHeader>
          <ContributionWizard
            key={wizardTick}
            onDone={() => {
              setWizardOpen(false);
              setWizardTick((t) => t + 1);
            }}
          />
        </DialogContent>
      </Dialog>

      {/* ===== Receipt dialog ===== */}
      <Dialog open={!!receiptBatchId} onOpenChange={(open) => !open && setReceiptBatchId(null)}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-auto">
          <DialogHeader>
            <DialogTitle className="text-[#0B1F2A]">Payment Receipt</DialogTitle>
            <DialogDescription>
              Audit-ready record — print or export for accounting and HR files.
            </DialogDescription>
          </DialogHeader>
          {receiptBatchId && detail ? (
            <PaymentReceipt
              batch={detail.batch}
              employer={employer}
              records={detail.records.filter((r) => r.validationStatus === "valid")}
              settlements={detail.settlements}
            />
          ) : (
            <LoadingBlock label="Preparing receipt…" />
          )}
        </DialogContent>
      </Dialog>
    </DashboardShell>
  );
}

/** Resume button shown when a batch is stuck in processing (failure recovery). */
function ResumePipeline({ batchId }: { batchId: Id<"contributionBatches"> }) {
  const pipeline = useMutation(api.engine.resumePipeline);
  const [running, setRunning] = useState(false);
  return (
    <Button
      className="bg-[#007A4D] font-semibold hover:bg-[#006A43]"
      disabled={running}
      onClick={async () => {
        setRunning(true);
        try {
          await pipeline({ batchId });
          toast.success("Pipeline resumed — batch updated");
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Resume failed");
        } finally {
          setRunning(false);
        }
      }}
    >
      {running ? (
        <RefreshCw className="size-4 animate-spin" />
      ) : (
        <CheckCircle2 className="size-4" />
      )}
      Resume processing
    </Button>
  );
}

/** Live PFA submission summary for the latest batch (Rae's key requirement). */
function PfaSubmissionSummary({
  batchId,
  pfaNameById,
}: {
  batchId: Id<"contributionBatches">;
  pfaNameById: Map<Id<"pfas">, string>;
}) {
  const detail = useQuery(api.pension.getBatchDetail, { batchId });
  if (!detail) {
    return (
      <div className="pen-tile flex items-center gap-2 p-4 text-sm text-[#5A6B74]">
        Loading PFA submission status…
      </div>
    );
  }
  const settlements = detail.settlements ?? [];
  const acks = detail.pfaAcks ?? [];
  const ackBySettlement = new Map(acks.map((a) => [a.settlementId, a]));

  if (settlements.length === 0) {
    return (
      <div className="pen-tile p-4 text-sm text-[#5A6B74]">
        PFA settlement instructions will appear here as soon as payment completes.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-bold tracking-tight text-[#0B1F2A]">
          PFA submission status
        </h3>
        <span className="text-xs text-[#5A6B74]">
          {settlements.length} PFAs ·{" "}
          {settlements.reduce((s, x) => s + x.employeeCount, 0)} employees routed
        </span>
      </div>
      {settlements.length > 0 && (
        <p className="mb-3 rounded border border-[#D4AF37]/30 bg-[#F5EFD9] px-3 py-2 text-xs font-semibold leading-relaxed text-[#7A6412]">
          {settlements.every((s) => s.pfaMode === "live_api")
            ? "Live PFA integration — statuses reflect external PFA confirmations."
            : "Sandbox mode — settlement and PFA acknowledgement statuses below are simulated test results, not externally confirmed settlements."}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {settlements.map((s) => {
          const ack = ackBySettlement.get(s._id);
          return (
            <div key={s._id} className="pen-tile p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-semibold text-[#0B1F2A]">
                  {pfaNameById.get(s.pfaId) ?? s.pfaName ?? "PFA"}
                </p>
                <StatusPill status={ack?.status ?? s.status} pulse={s.status === "processing"} />
              </div>
              <p className="mt-2 text-lg font-bold tabular-nums text-[#0B1F2A]">
                {fmtNaira(s.amount)}
              </p>
              <p className="text-xs text-[#5A6B74]">
                {s.employeeCount} employees · {s.settlementRef}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
