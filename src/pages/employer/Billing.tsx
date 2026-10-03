import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { DashboardShell } from "@/components/DashboardShell";
import {
  ClayTable,
  LoadingBlock,
  PageHeader,
  StatTile,
} from "@/components/pension-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtNaira, monthName } from "@/lib/pension";
import { Download, Info } from "lucide-react";

function periodLabel(periodKey: string): string {
  const [y, m] = periodKey.split("-").map(Number);
  return `${monthName(m)} ${y}`;
}

export default function Billing() {
  const billing = useQuery(api.billing.getEmployerBilling);

  if (billing === undefined) {
    return (
      <DashboardShell>
        <LoadingBlock label="Loading billing…" />
      </DashboardShell>
    );
  }
  if (billing === null) {
    return (
      <DashboardShell>
        <PageHeader title="Billing" description="Penroute service charges and usage." />
        <div className="pen-card p-8 text-center text-sm text-muted-foreground">
          No employer profile found. Complete onboarding to view billing.
        </div>
      </DashboardShell>
    );
  }

  const { current, pending, history, currentSubscription, disclaimer } = billing;
  const now = new Date();
  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const downloadStatement = () => {
    if (!current) return;
    const rows: (string | number)[][] = [
      ["Penroute statement", periodLabel(currentKey)],
      ["Employer", billing.employerName],
      ["Billing period", periodLabel(current.periodKey)],
      ["Pricing tier", current.tierLabel],
      ["Rate per posting (NGN)", (current.feePerPostingKobo / 100).toFixed(2)],
      ["Employees processed / postings", current.postingCount],
      [
        "Penroute processing fee (NGN)",
        (current.processingFeeKobo / 100).toFixed(2),
      ],
      [
        "Platform subscription (NGN)",
        (current.subscriptionFeeKobo / 100).toFixed(2),
      ],
      [
        "Total Penroute service charge (NGN)",
        (current.totalPenrouteChargeKobo / 100).toFixed(2),
      ],
      [
        "Pension contribution (routed to PFA — not a Penroute charge) (NGN)",
        (current.contributionKobo / 100).toFixed(2),
      ],
      [
        "Total amount processed (NGN)",
        (current.totalProcessedKobo / 100).toFixed(2),
      ],
      ["Transaction references", current.transactionRefs.join(" | ") || "—"],
      ["Status", current.status],
      [],
      [
        "Penroute processing fees and subscriptions are Penroute technology/service charges, separate from pension contributions.",
      ],
    ];
    const csv = rows
      .map((r) =>
        r
          .map((cell) => {
            const s = String(cell ?? "");
            return /["\n,\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(","),
      )
      .join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `penroute-statement-${currentKey}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <DashboardShell>
      <PageHeader
        title="Billing"
        description={`${periodLabel(currentKey)} · Penroute service charges for ${billing.employerName} — separate from pension contributions.`}
        actions={
          <Button
            size="sm"
            variant="outline"
            className="text-xs font-semibold"
            onClick={downloadStatement}
            disabled={!current}
          >
            <Download className="mr-1.5 size-3.5" /> Download statement
          </Button>
        }
      />

      {/* ---------------- Current billing period ---------------- */}
      <section className="pen-card-lg p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="pen-sidebar-label !text-[#5A6B74]">Current billing period</p>
            <h2 className="mt-1 text-lg font-bold tracking-tight">
              {periodLabel(currentKey)}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {current && (
              <Badge
                className={
                  current.status === "paid"
                    ? "bg-[#E6F6EF] text-[#04593A]"
                    : current.status === "failed"
                      ? "bg-[#FBEAE8] text-[#8A2F28]"
                      : "bg-[#FBF3E0] text-[#7A5A10]"
                }
              >
                {current.status.replace(/_/g, " ")}
              </Badge>
            )}
            {currentSubscription && (
              <Badge variant="outline">{currentSubscription.planName} plan</Badge>
            )}
          </div>
        </div>

        {pending && (
          <div className="mt-4 rounded-lg border border-[#E4C77A]/60 bg-[#FBF3E0] px-4 py-3 text-sm text-[#7A5A10]">
            <span className="font-semibold">Awaiting payment:</span>{" "}
            {pending.postingCount} postings on batch {pending.batchRef} — Penroute
            processing fee {fmtNaira(pending.processingFeeKobo)} at{" "}
            {fmtNaira(pending.feePerPostingKobo)} per posting ({pending.tierLabel}).
            Amounts appear below as soon as the payment is confirmed.
          </div>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Employees processed"
            value={String(current?.postingCount ?? 0)}
            sub={`${current?.postingCount ?? 0} postings this period`}
          />
          <StatTile
            label="Applicable Penroute rate"
            value={fmtNaira(current?.feePerPostingKobo ?? 0, { noKobo: true })}
            sub={current?.tierLabel ?? "—"}
          />
          <StatTile
            label="Processing fees"
            value={fmtNaira(current?.processingFeeKobo ?? 0)}
            sub="Penroute technology/service charge"
          />
          <StatTile
            label="Platform subscription"
            value={fmtNaira(current?.subscriptionFeeKobo ?? 0)}
            sub={current?.subscriptionPlan ?? "No subscription plan assigned"}
          />
          <StatTile
            label="Total Penroute service charge"
            value={fmtNaira(current?.totalPenrouteChargeKobo ?? 0)}
            sub="Processing fee + subscription"
            tone="text-[#04593A]"
          />
          <StatTile
            label="Pension contribution"
            value={fmtNaira(current?.contributionKobo ?? 0)}
            sub="Routed to your employees' PFAs — not a Penroute charge"
          />
          <StatTile
            label="Total amount processed"
            value={fmtNaira(current?.totalProcessedKobo ?? 0)}
            sub="Pension contribution + processing fee"
          />
          <StatTile
            label="Transaction references"
            value={String(current?.transactionRefs.length ?? 0)}
            sub={current?.transactionRefs.slice(0, 2).join(", ") || "—"}
          />
        </div>

        {current && current.paymentRefs.length > 0 && (
          <p className="mt-4 text-xs text-muted-foreground">
            Payment references: {current.paymentRefs.join(", ")}
          </p>
        )}
      </section>

      {/* ---------------- Previous billing periods ---------------- */}
      <section>
        <h2 className="mb-3 text-sm font-bold tracking-tight">
          Previous billing periods
        </h2>
        <ClayTable
          headers={[
            "Billing period",
            "Postings",
            "Rate",
            "Processing fee",
            "Subscription",
            "Total Penroute charge",
            "Pension contribution",
            "Status",
            "Transaction reference",
          ]}
          isEmpty={history.length === 0}
          emptyMessage="No previous billing periods — your first statement appears after a completed payment."
          exportRows={history.map((h) => [
            periodLabel(h.periodKey),
            h.postingCount,
            (h.feePerPostingKobo / 100).toFixed(2),
            (h.processingFeeKobo / 100).toFixed(2),
            (h.subscriptionFeeKobo / 100).toFixed(2),
            (h.totalPenrouteChargeKobo / 100).toFixed(2),
            (h.contributionKobo / 100).toFixed(2),
            h.status,
            h.transactionRefs.join(" | "),
          ])}
          exportName={`penroute-billing-history-${now.getFullYear()}.csv`}
        >
          {history.map((h) => (
            <tr key={h.periodKey} className="pen-table-row">
              <td className="px-3 py-2.5 text-sm font-medium">
                {periodLabel(h.periodKey)}
              </td>
              <td className="px-3 py-2.5 tabular-nums">{h.postingCount}</td>
              <td className="px-3 py-2.5 tabular-nums">
                {fmtNaira(h.feePerPostingKobo)}
              </td>
              <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                {fmtNaira(h.processingFeeKobo)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                {h.subscriptionFeeKobo > 0
                  ? `${fmtNaira(h.subscriptionFeeKobo)}${h.subscriptionPlan ? ` · ${h.subscriptionPlan}` : ""}`
                  : "—"}
              </td>
              <td className="px-3 py-2.5 text-right font-semibold tabular-nums">
                {fmtNaira(h.totalPenrouteChargeKobo)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                {fmtNaira(h.contributionKobo)}
              </td>
              <td className="px-3 py-2.5">
                <Badge
                  variant="outline"
                  className={
                    h.status === "paid"
                      ? "border-[#007A4D]/40 text-[#04593A]"
                      : "text-muted-foreground"
                  }
                >
                  {h.status.replace(/_/g, " ")}
                </Badge>
              </td>
              <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
                {h.transactionRefs[0] ?? "—"}
              </td>
            </tr>
          ))}
        </ClayTable>
      </section>

      {/* ---------------- Plain-language separation note ---------------- */}
      <section className="pen-card p-5">
        <div className="flex gap-3">
          <Info className="mt-0.5 size-4 shrink-0 text-[#007A4D]" />
          <p className="text-sm leading-relaxed text-[#5A6B74]">{disclaimer}</p>
        </div>
      </section>
    </DashboardShell>
  );
}
