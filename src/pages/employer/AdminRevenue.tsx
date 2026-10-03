import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DashboardShell } from "@/components/DashboardShell";
import { ClayTable, LoadingBlock, PageHeader, StatTile } from "@/components/pension-ui";
import { fmtNaira } from "@/lib/pension";
import { BarChart3, Info } from "lucide-react";

/**
 * ADMINISTRATOR REVENUE ANALYTICS — gross service revenue derived from the
 * configured pricing engine. Every figure is labelled REVENUE (before
 * operating costs), never profit. Backend aggregates only — no raw transaction
 * dumps reach the client, so this scales to millions of postings.
 */
export default function AdminRevenue() {
  const { user } = useAuth();
  const [window_, setWindow] = useState(12);
  const report = useQuery(api.billing.getAdminRevenueReport, { months: window_ });
  const analytics = useQuery(api.billing.getRevenueAnalytics, {});

  if (user === undefined) {
    return (
      <DashboardShell>
        <LoadingBlock label="Verifying access…" />
      </DashboardShell>
    );
  }
  if (!user || user.role !== "admin") {
    return (
      <DashboardShell>
        <PageHeader title="Revenue" />
        <div className="pen-card p-8 text-center text-sm text-muted-foreground">
          Administrator access is required to view revenue analytics.
        </div>
      </DashboardShell>
    );
  }
  if (!report || !analytics) {
    return (
      <DashboardShell>
        <LoadingBlock label="Loading revenue analytics…" />
      </DashboardShell>
    );
  }

  const { totals } = report;

  return (
    <DashboardShell>
      <PageHeader
        title="Revenue analytics"
        description="Gross Penroute service revenue — processing fees and platform subscriptions — computed from the configured pricing engine."
        actions={
          <div className="flex gap-1.5">
            {[6, 12, 24].map((m) => (
              <Button
                key={m}
                size="sm"
                variant={window_ === m ? "default" : "outline"}
                className="h-8 text-xs"
                onClick={() => setWindow(m)}
              >
                {m} months
              </Button>
            ))}
          </div>
        }
      />

      {/* ---------------- Headline figures ---------------- */}
      <section className="pen-card-lg p-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Processing-fee revenue"
            value={fmtNaira(totals.processingRevenueKobo)}
            sub={`${totals.postingCount.toLocaleString()} postings · ${report.windowMonths}-month window`}
            tone="text-[#04593A]"
          />
          <StatTile
            label="Subscription revenue"
            value={fmtNaira(totals.subscriptionRevenueKobo)}
            sub="platform subscriptions in window"
            tone="text-[#04593A]"
          />
          <StatTile
            label="Total gross service revenue"
            value={fmtNaira(totals.grossServiceRevenueKobo)}
            sub="processing + subscription"
            tone="text-[#04593A]"
          />
          <StatTile
            label="Pension contribution value processed"
            value={fmtNaira(totals.pensionContributionValueKobo)}
            sub="employer funds routed to PFAs — NOT revenue"
          />
          <StatTile label="Employers" value={String(totals.employerCount)} sub="with recognised revenue" />
          <StatTile label="Postings" value={String(totals.postingCount)} sub="billable employee postings" />
          <StatTile label="Billing charges" value={String(totals.chargeCount)} sub="paid batches in window" />
          <StatTile label="Reporting window" value={`${report.windowMonths} mo`} sub="indexed period aggregation" />
        </div>
        <div className="mt-4 flex gap-3 rounded-lg border border-[#E4C77A]/60 bg-[#FBF3E0] px-4 py-3 text-xs leading-relaxed text-[#7A5A10]">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>{report.disclaimer}</span>
        </div>
      </section>

      {/* ---------------- By tier + by month ---------------- */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="pen-card-lg p-6">
          <h2 className="mb-4 text-sm font-bold tracking-tight">Revenue by pricing tier</h2>
          <ClayTable
            headers={["Tier", "Rate / posting", "Postings", "Processing revenue"]}
            isEmpty={report.byTier.length === 0}
            emptyMessage="No recognised revenue in this window."
            exportRows={report.byTier.map((t) => [
              t.tierLabel,
              (t.feePerPostingKobo / 100).toFixed(2),
              t.postingCount,
              (t.processingFeeKobo / 100).toFixed(2),
            ])}
            exportName="penroute-revenue-by-tier.csv"
          >
            {report.byTier.map((t) => (
              <tr key={t.tierCode} className="pen-table-row">
                <td className="px-3 py-2.5 text-sm font-medium">{t.tierLabel}</td>
                <td className="px-3 py-2.5 tabular-nums">{fmtNaira(t.feePerPostingKobo)}</td>
                <td className="px-3 py-2.5 tabular-nums">{t.postingCount.toLocaleString()}</td>
                <td className="px-3 py-2.5 text-right font-semibold tabular-nums">
                  {fmtNaira(t.processingFeeKobo)}
                </td>
              </tr>
            ))}
          </ClayTable>
        </div>

        <div className="pen-card-lg p-6">
          <h2 className="mb-4 text-sm font-bold tracking-tight">Revenue by month</h2>
          <ClayTable
            headers={["Month", "Postings", "Pension processed", "Processing revenue"]}
            isEmpty={report.byMonth.every((m) => m.chargeCount === 0)}
            emptyMessage="No recognised revenue in this window."
            exportRows={report.byMonth.map((m) => [
              m.periodKey,
              m.postingCount,
              (m.contributionKobo / 100).toFixed(2),
              (m.processingFeeKobo / 100).toFixed(2),
            ])}
            exportName="penroute-revenue-by-month.csv"
          >
            {report.byMonth.map((m) => (
              <tr key={m.periodKey} className="pen-table-row">
                <td className="px-3 py-2.5 text-sm font-medium">{m.periodKey}</td>
                <td className="px-3 py-2.5 tabular-nums">{m.postingCount.toLocaleString()}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                  {fmtNaira(m.contributionKobo)}
                </td>
                <td className="px-3 py-2.5 text-right font-semibold tabular-nums">
                  {fmtNaira(m.processingFeeKobo)}
                </td>
              </tr>
            ))}
          </ClayTable>
        </div>
      </section>

      {/* ---------------- By employer ---------------- */}
      <section className="pen-card-lg p-6">
        <h2 className="mb-4 text-sm font-bold tracking-tight">Revenue by employer</h2>
        <ClayTable
          headers={["Employer", "Charges", "Postings", "Processing revenue"]}
          isEmpty={report.byEmployer.length === 0}
          emptyMessage="No recognised revenue in this window."
          exportRows={report.byEmployer.map((e) => [
            e.employerName,
            e.chargeCount,
            e.postingCount,
            (e.processingFeeKobo / 100).toFixed(2),
          ])}
          exportName="penroute-revenue-by-employer.csv"
        >
          {report.byEmployer.map((e) => (
            <tr key={e.employerId} className="pen-table-row">
              <td className="px-3 py-2.5 text-sm font-medium">{e.employerName}</td>
              <td className="px-3 py-2.5 tabular-nums">{e.chargeCount}</td>
              <td className="px-3 py-2.5 tabular-nums">{e.postingCount.toLocaleString()}</td>
              <td className="px-3 py-2.5 text-right font-semibold tabular-nums">
                {fmtNaira(e.processingFeeKobo)}
              </td>
            </tr>
          ))}
        </ClayTable>
      </section>

      {/* ---------------- Scale scenarios ---------------- */}
      <section className="pen-card-lg p-6">
        <div className="mb-1 flex items-center gap-2">
          <BarChart3 className="size-5 text-[#007A4D]" />
          <h2 className="text-sm font-bold tracking-tight">
            Projected revenue at scale — computed from the live pricing engine
          </h2>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          One month of postings at each volume, priced with the currently
          configured tiers. Gross revenue before operating costs — not profit.
        </p>
        <ClayTable
          headers={[
            "Employee posting volume",
            "Applicable tier",
            "Rate / posting",
            "Monthly processing revenue",
            "Annualised (×12)",
          ]}
          isEmpty={analytics.scenarios.length === 0}
          emptyMessage="No scenarios available."
          exportRows={analytics.scenarios.map((s) => [
            s.postingVolume,
            s.tierLabel,
            (s.feePerPostingKobo / 100).toFixed(2),
            (s.monthlyProcessingRevenueKobo / 100).toFixed(2),
            (s.annualProcessingRevenueKobo / 100).toFixed(2),
          ])}
          exportName="penroute-revenue-scenarios.csv"
        >
          {analytics.scenarios.map((s) => (
            <tr key={s.postingVolume} className="pen-table-row">
              <td className="px-3 py-2.5 text-sm font-semibold tabular-nums">
                {s.postingVolume.toLocaleString()} employees
              </td>
              <td className="px-3 py-2.5">
                <Badge variant="outline">{s.tierLabel}</Badge>
              </td>
              <td className="px-3 py-2.5 tabular-nums">{fmtNaira(s.feePerPostingKobo)}</td>
              <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-[#04593A]">
                {fmtNaira(s.monthlyProcessingRevenueKobo)}
              </td>
              <td className="px-3 py-2.5 text-right font-semibold tabular-nums">
                {fmtNaira(s.annualProcessingRevenueKobo)}
              </td>
            </tr>
          ))}
        </ClayTable>

        <div className="mt-5 rounded-lg border border-border/60 bg-[#F7F9F8] p-4">
          <p className="text-xs font-bold text-[#5A6B74]">
            Subscription plans (optional layer)
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {analytics.plans.map((p) => (
              <span
                key={p.code}
                className="rounded-full border border-border/60 bg-white px-3 py-1 text-xs font-semibold"
              >
                {p.name}: {p.priceIsFrom ? "from " : ""}
                {fmtNaira(p.monthlyPriceKobo)}/mo {p.active ? "" : "(disabled)"}
              </span>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            All active plans combined:{" "}
            {fmtNaira(analytics.subscriptionRevenueAllPlansKobo)}/month in potential
            subscription revenue.
          </p>
        </div>
        <div className="mt-4 flex gap-3 rounded-lg border border-[#E4C77A]/60 bg-[#FBF3E0] px-4 py-3 text-xs leading-relaxed text-[#7A5A10]">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>{analytics.disclaimer}</span>
        </div>
      </section>
    </DashboardShell>
  );
}
