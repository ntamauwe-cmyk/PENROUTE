import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { DashboardShell } from "@/components/DashboardShell";
import {
  ClayTable,
  LoadingBlock,
  PageHeader,
  StatTile,
  StatusPill,
} from "@/components/pension-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtDateTime, fmtNaira } from "@/lib/pension";
import { Loader2, LogOut, Search, ShieldAlert } from "lucide-react";
import { Link } from "react-router";

// ============================================================================
// PFA PORTAL (role: "pfa") — every section reads only the session user's own
// PFA data (scoped server-side by pfaPortal.ts). This file never receives a
// pfaId from the URL: the backend derives it from the signed-in user.
// ============================================================================

export type PfaSection =
  | "home"
  | "settlements"
  | "contributions"
  | "employees"
  | "employers"
  | "exceptions";

export default function PfaPortal({ section }: { section: PfaSection }) {
  const { user, signOut } = useAuth();
  const claimAccess = useMutation(api.pfaPortal.claimAccess);
  const attempted = useRef(false);
  const [claimState, setClaimState] = useState<"pending" | "claimed" | "none">(
    "pending",
  );

  // First sign-in for a provisioned operator: activate the administrator's
  // grant (role → pfa). Runs at most once per mount, and never for users who
  // already hold the role.
  useEffect(() => {
    if (user === undefined || user?.role === "pfa" || attempted.current) return;
    attempted.current = true;
    let alive = true;
    claimAccess({})
      .then((res) => {
        if (alive) setClaimState(res.claimed ? "claimed" : "none");
      })
      .catch(() => {
        if (alive) setClaimState("none");
      });
    return () => {
      alive = false;
    };
  }, [user, claimAccess]);

  // Safety net: if a claim reported success but the role never arrives
  // (should not happen), fall through to the access screen instead of
  // loading forever.
  useEffect(() => {
    if (claimState !== "claimed") return;
    const t = setTimeout(() => setClaimState("none"), 4000);
    return () => clearTimeout(t);
  }, [claimState]);

  if (user === undefined) {
    return <CenteredLoading label="Loading portal…" />;
  }

  if (user?.role === "pfa" && user.pfaId) {
    return (
      <DashboardShell>
        <SectionView section={section} />
      </DashboardShell>
    );
  }

  if (claimState === "pending" || claimState === "claimed") {
    return <CenteredLoading label="Setting up your portal…" />;
  }

  return <AccessDenied onSignOut={signOut} />;
}

function CenteredLoading({ label }: { label: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <img
          src="/brand/penroute-mark-traced.svg"
          className="size-9"
          alt=""
          aria-hidden="true"
        />
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {label}
        </p>
      </div>
    </main>
  );
}

function AccessDenied({ onSignOut }: { onSignOut: () => void }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#F7F9F8] px-4 py-12">
      <div className="pen-card-lg w-full max-w-md p-8 text-center">
        <span className="mx-auto flex size-12 items-center justify-center rounded-xl bg-[#FBEAE8]">
          <ShieldAlert className="size-6 text-[#C4453C]" />
        </span>
        <h1 className="mt-5 text-xl font-bold tracking-tight text-[#0B1F2A]">
          PFA portal access required
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-[#5A6B74]">
          This workspace is limited to Pension Fund Administrator accounts
          provisioned by Penroute administration. Sign in with the email your
          administrator registered for your PFA, or request access from your
          Penroute administrator.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <Button
            className="h-11 w-full bg-[#007A4D] font-semibold hover:bg-[#006A43]"
            onClick={onSignOut}
          >
            <LogOut className="mr-2 size-4" /> Sign out
          </Button>
          <Link
            to="/"
            className="h-11 w-full rounded-lg border border-[#0B1F2A]/15 text-sm font-semibold leading-10 text-[#0B1F2A] hover:bg-[#F0F4F4]"
          >
            Back to penroute.net
          </Link>
        </div>
      </div>
    </main>
  );
}

function SectionView({ section }: { section: PfaSection }) {
  switch (section) {
    case "settlements":
      return <PfaSettlements />;
    case "contributions":
      return <PfaContributions />;
    case "employees":
      return <PfaMembers />;
    case "employers":
      return <PfaEmployers />;
    case "exceptions":
      return <PfaExceptions />;
    case "home":
    default:
      return <PfaHome />;
  }
}

// ---------------------------------------------------------------- shared bits

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative w-full sm:w-80">
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        className="pl-9"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </div>
  );
}

function StatusFilter({
  options,
  value,
  onChange,
}: {
  options: { key: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
            value === o.key
              ? "border-[#007A4D] bg-[#E6F6EF] text-[#04593A]"
              : "border-border bg-white text-muted-foreground hover:bg-[#F0F4F4]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function matches(needle: string, haystacks: (string | number | null | undefined)[]) {
  if (!needle.trim()) return true;
  const q = needle.trim().toLowerCase();
  return haystacks.some((h) => h != null && String(h).toLowerCase().includes(q));
}

const SANDBOX_NOTE =
  "Sandbox adapter — settlement and acknowledgement statuses shown here are simulated test results, not externally confirmed settlements.";

// ------------------------------------------------------------------- overview

function PfaHome() {
  const data = useQuery(api.pfaPortal.getOverview);
  if (!data) return <LoadingBlock label="Loading PFA overview…" />;

  const { pfa, stats, recentSettlements, openExceptions } = data;
  const live = pfa.integrationMode === "live_api";

  return (
    <>
      <PageHeader
        title={pfa.name}
        description={`PFA portal · Penroute reference code ${pfa.code} · contributions, settlements and members flowing to ${pfa.shortName ?? pfa.name}.`}
        actions={
          <Badge
            className={
              live
                ? "bg-[#E6F6EF] text-[#04593A]"
                : "bg-[#FBF3E0] text-[#7A5A10]"
            }
          >
            {pfa.integrationStatusLabel}
          </Badge>
        }
      />

      {!pfa.active && (
        <div className="rounded-lg border border-[#C4453C]/30 bg-[#FBEAE8] px-4 py-3 text-sm text-[#8A2F28]">
          This PFA record is deactivated on Penroute — historical data remains
          readable, but no new activity will be routed here.
        </div>
      )}

      {!live && (
        <div className="rounded-lg border border-[#E4C77A]/60 bg-[#FBF3E0] px-4 py-3 text-sm text-[#7A5A10]">
          {SANDBOX_NOTE}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Total contributions"
          value={fmtNaira(stats.totalContributions)}
          sub={`${stats.recordCount} contribution records`}
        />
        <StatTile
          label="Settled remittances"
          value={fmtNaira(stats.settledAmount)}
          sub={`${stats.settledCount} settlements`}
          tone="text-[#04593A]"
        />
        <StatTile
          label="In transit"
          value={fmtNaira(stats.pendingAmount)}
          sub={`${stats.pendingCount} pending settlements`}
        />
        <StatTile
          label="Members"
          value={String(stats.memberCount)}
          sub="RSA accounts held with this PFA"
        />
        <StatTile
          label="Employers"
          value={String(stats.employerCount)}
          sub="remitting to this PFA"
        />
        <StatTile
          label="Open exceptions"
          value={String(stats.openExceptions)}
          sub="awaiting resolution"
          tone={stats.openExceptions > 0 ? "text-[#C4453C]" : undefined}
        />
      </div>

      <section>
        <h2 className="mb-3 text-sm font-bold tracking-tight">
          Recent settlement instructions
        </h2>
        <ClayTable
          headers={[
            "Settlement",
            "Employer",
            "Batch",
            "Members",
            "Amount",
            "Status",
            "Instructed",
          ]}
          isEmpty={recentSettlements.length === 0}
          emptyMessage="No settlements have been instructed to this PFA yet."
        >
          {recentSettlements.map((s) => (
            <tr key={s.settlementId} className="border-t border-border/50">
              <td className="px-3 py-2.5 font-mono text-xs">
                {s.settlementRef}
              </td>
              <td className="px-3 py-2.5 text-sm">{s.employerName}</td>
              <td className="px-3 py-2.5 font-mono text-xs">{s.batchRef}</td>
              <td className="px-3 py-2.5 tabular-nums">{s.employeeCount}</td>
              <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                {fmtNaira(s.amount)}
              </td>
              <td className="px-3 py-2.5">
                <StatusPill status={s.status} />
              </td>
              <td className="px-3 py-2.5 text-xs text-muted-foreground">
                {fmtDateTime(s.instructedAt)}
              </td>
            </tr>
          ))}
        </ClayTable>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-bold tracking-tight">
          Open exceptions
        </h2>
        <ClayTable
          headers={["Ref", "Type", "Detail", "Amount", "Status", "Raised"]}
          isEmpty={openExceptions.length === 0}
          emptyMessage="No open exceptions attributed to this PFA."
        >
          {openExceptions.map((e) => (
            <tr key={e._id} className="border-t border-border/50">
              <td className="px-3 py-2.5 font-mono text-xs">{e.exceptionRef}</td>
              <td className="px-3 py-2.5">
                <Badge variant="outline">{e.type.replace(/_/g, " ")}</Badge>
              </td>
              <td className="max-w-md px-3 py-2.5 text-xs text-muted-foreground">
                {e.description}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                {e.amount != null ? fmtNaira(e.amount) : "—"}
              </td>
              <td className="px-3 py-2.5">
                <StatusPill status={e.status} />
              </td>
              <td className="px-3 py-2.5 text-xs text-muted-foreground">
                {fmtDateTime(e.createdAt)}
              </td>
            </tr>
          ))}
        </ClayTable>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- settlements

function PfaSettlements() {
  const rows = useQuery(api.pfaPortal.listSettlements);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");

  if (!rows) return <LoadingBlock label="Loading settlements…" />;

  const filtered = rows.filter(
    (s) =>
      (status === "all" || s.status === status) &&
      matches(q, [s.settlementRef, s.batchRef, s.employerName, s.period]),
  );

  return (
    <>
      <PageHeader
        title="Settlements"
        description="Remittance instructions addressed to this PFA, newest first."
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder="Search reference, batch or employer…"
        />
        <StatusFilter
          value={status}
          onChange={setStatus}
          options={[
            { key: "all", label: "All" },
            { key: "pending", label: "Pending" },
            { key: "processing", label: "Processing" },
            { key: "settled", label: "Settled" },
            { key: "failed", label: "Failed" },
          ]}
        />
      </div>
      <ClayTable
        headers={[
          "Settlement",
          "Batch",
          "Period",
          "Employer",
          "Members",
          "Amount",
          "Settlement status",
          "Acknowledgement",
          "Instructed",
        ]}
        isEmpty={filtered.length === 0}
        emptyMessage={
          rows.length === 0
            ? "No settlements have been instructed to this PFA yet."
            : "No settlements match your search."
        }
        exportRows={filtered.map((s) => [
          s.settlementRef,
          s.batchRef,
          s.period,
          s.employerName,
          s.employeeCount,
          (s.amount / 100).toFixed(2),
          s.status,
          s.ackStatus ?? s.batchPfaStatus ?? "awaiting ack",
          fmtDateTime(s.instructedAt),
        ])}
        exportName="penroute-settlements.csv"
      >
        {filtered.map((s) => (
          <tr key={s._id} className="border-t border-border/50">
            <td className="px-3 py-2.5 font-mono text-xs">{s.settlementRef}</td>
            <td className="px-3 py-2.5 font-mono text-xs">{s.batchRef}</td>
            <td className="px-3 py-2.5 text-xs">{s.period}</td>
            <td className="px-3 py-2.5 text-sm">{s.employerName}</td>
            <td className="px-3 py-2.5 tabular-nums">{s.employeeCount}</td>
            <td className="px-3 py-2.5 text-right font-medium tabular-nums">
              {fmtNaira(s.amount)}
            </td>
            <td className="px-3 py-2.5">
              <StatusPill status={s.status} />
            </td>
            <td className="px-3 py-2.5">
              <StatusPill status={s.ackStatus ?? s.batchPfaStatus ?? "awaiting_ack"} />
            </td>
            <td className="px-3 py-2.5 text-xs text-muted-foreground">
              {fmtDateTime(s.instructedAt)}
            </td>
          </tr>
        ))}
      </ClayTable>
    </>
  );
}

// -------------------------------------------------------------- contributions

function PfaContributions() {
  const rows = useQuery(api.pfaPortal.listContributions);
  const [q, setQ] = useState("");

  if (!rows) return <LoadingBlock label="Loading contributions…" />;

  const filtered = rows.filter((r) =>
    matches(q, [
      r.recordRef,
      r.fullName,
      r.pensionPin,
      r.employerName,
      r.batchRef,
      r.period,
    ]),
  );

  return (
    <>
      <PageHeader
        title="Contributions"
        description="Employee contribution records allocated to this PFA."
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder="Search name, RSA PIN, employer or batch…"
        />
        <p className="text-xs text-muted-foreground">
          {filtered.length} of {rows.length} records
        </p>
      </div>
      <ClayTable
        headers={[
          "Record",
          "Employee",
          "RSA PIN",
          "Employer",
          "Batch",
          "Period",
          "Employee credit",
          "Employer credit",
          "Total",
          "Validation",
          "PFA status",
        ]}
        isEmpty={filtered.length === 0}
        emptyMessage={
          rows.length === 0
            ? "No contributions have been allocated to this PFA yet."
            : "No contributions match your search."
        }
        exportRows={filtered.map((r) => [
          r.recordRef,
          r.fullName,
          r.pensionPin,
          r.employerName,
          r.batchRef,
          r.period,
          (r.employeeContribution / 100).toFixed(2),
          (r.employerContribution / 100).toFixed(2),
          (r.totalAmount / 100).toFixed(2),
          r.validationStatus,
          r.pfaStatus,
        ])}
        exportName="penroute-contributions.csv"
      >
        {filtered.map((r) => (
          <tr key={r._id} className="border-t border-border/50">
            <td className="px-3 py-2.5 font-mono text-xs">{r.recordRef}</td>
            <td className="px-3 py-2.5 text-sm font-medium">{r.fullName}</td>
            <td className="px-3 py-2.5 font-mono text-xs">{r.pensionPin}</td>
            <td className="px-3 py-2.5 text-sm">{r.employerName}</td>
            <td className="px-3 py-2.5 font-mono text-xs">{r.batchRef}</td>
            <td className="px-3 py-2.5 text-xs">{r.period}</td>
            <td className="px-3 py-2.5 text-right tabular-nums">
              {fmtNaira(r.employeeContribution)}
            </td>
            <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
              {fmtNaira(r.employerContribution)}
            </td>
            <td className="px-3 py-2.5 text-right font-medium tabular-nums">
              {fmtNaira(r.totalAmount)}
            </td>
            <td className="px-3 py-2.5">
              <StatusPill status={r.validationStatus} />
            </td>
            <td className="px-3 py-2.5">
              <StatusPill status={r.pfaStatus} />
            </td>
          </tr>
        ))}
      </ClayTable>
    </>
  );
}

// ------------------------------------------------------------------- members

function PfaMembers() {
  const rows = useQuery(api.pfaPortal.listEmployees);
  const [q, setQ] = useState("");

  if (!rows) return <LoadingBlock label="Loading members…" />;

  const filtered = rows.filter((e) =>
    matches(q, [e.fullName, e.pensionPin, e.employeeCode, e.employerName]),
  );

  return (
    <>
      <PageHeader
        title="Members"
        description="Employees whose RSA accounts are registered with this PFA."
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder="Search name, RSA PIN or employer…"
        />
        <p className="text-xs text-muted-foreground">
          {filtered.length} of {rows.length} members
        </p>
      </div>
      <ClayTable
        headers={["Member", "RSA PIN", "Employee code", "Employer", "Status", "Registered"]}
        isEmpty={filtered.length === 0}
        emptyMessage={
          rows.length === 0
            ? "No members are registered with this PFA yet."
            : "No members match your search."
        }
        exportRows={filtered.map((e) => [
          e.fullName,
          e.pensionPin,
          e.employeeCode,
          e.employerName,
          e.active ? "active" : "inactive",
          fmtDateTime(e.createdAt),
        ])}
        exportName="penroute-members.csv"
      >
        {filtered.map((e) => (
          <tr key={e._id} className="border-t border-border/50">
            <td className="px-3 py-2.5 text-sm font-medium">{e.fullName}</td>
            <td className="px-3 py-2.5 font-mono text-xs">{e.pensionPin}</td>
            <td className="px-3 py-2.5 font-mono text-xs">{e.employeeCode}</td>
            <td className="px-3 py-2.5 text-sm">{e.employerName}</td>
            <td className="px-3 py-2.5">
              <StatusPill status={e.active ? "active" : "inactive"} />
            </td>
            <td className="px-3 py-2.5 text-xs text-muted-foreground">
              {fmtDateTime(e.createdAt)}
            </td>
          </tr>
        ))}
      </ClayTable>
    </>
  );
}

// ----------------------------------------------------------------- employers

function PfaEmployers() {
  const rows = useQuery(api.pfaPortal.listEmployers);
  const [q, setQ] = useState("");

  if (!rows) return <LoadingBlock label="Loading employers…" />;

  const filtered = rows.filter((e) =>
    matches(q, [e.name, e.rcNumber, e.status]),
  );

  return (
    <>
      <PageHeader
        title="Employers"
        description="Employers remitting contributions to this PFA."
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder="Search employer or RC number…"
        />
        <p className="text-xs text-muted-foreground">
          {filtered.length} of {rows.length} employers
        </p>
      </div>
      <ClayTable
        headers={[
          "Employer",
          "RC number",
          "Status",
          "Members",
          "Records",
          "Contributions received",
          "Last activity",
        ]}
        isEmpty={filtered.length === 0}
        emptyMessage={
          rows.length === 0
            ? "No employers are remitting to this PFA yet."
            : "No employers match your search."
        }
      >
        {filtered.map((e) => (
          <tr key={e.employerId} className="border-t border-border/50">
            <td className="px-3 py-2.5 text-sm font-medium">{e.name}</td>
            <td className="px-3 py-2.5 font-mono text-xs">{e.rcNumber}</td>
            <td className="px-3 py-2.5">
              <Badge
                variant="secondary"
                className={
                  e.status === "active"
                    ? "bg-[#E6F6EF] text-[#04593A]"
                    : "bg-[#FBEAE8] text-[#8A2F28]"
                }
              >
                {e.status}
              </Badge>
            </td>
            <td className="px-3 py-2.5 tabular-nums">{e.memberCount}</td>
            <td className="px-3 py-2.5 tabular-nums">{e.recordCount}</td>
            <td className="px-3 py-2.5 text-right font-medium tabular-nums">
              {fmtNaira(e.contributionTotal)}
            </td>
            <td className="px-3 py-2.5 text-xs text-muted-foreground">
              {e.lastActivity ? fmtDateTime(e.lastActivity) : "—"}
            </td>
          </tr>
        ))}
      </ClayTable>
    </>
  );
}

// ----------------------------------------------------------------- exceptions

function PfaExceptions() {
  const rows = useQuery(api.pfaPortal.listExceptions);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");

  if (!rows) return <LoadingBlock label="Loading exceptions…" />;

  const filtered = rows.filter(
    (e) =>
      (status === "all" || e.status === status) &&
      matches(q, [
        e.exceptionRef,
        e.type,
        e.description,
        e.employerName,
        e.responsibleParty,
      ]),
  );

  return (
    <>
      <PageHeader
        title="Exceptions"
        description="Reconciliation and validation issues attributed to this PFA."
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder="Search reference, type or detail…"
        />
        <StatusFilter
          value={status}
          onChange={setStatus}
          options={[
            { key: "all", label: "All" },
            { key: "open", label: "Open" },
            { key: "investigating", label: "Investigating" },
            { key: "resolved", label: "Resolved" },
          ]}
        />
      </div>
      <ClayTable
        headers={[
          "Ref",
          "Employer",
          "Type",
          "Detail",
          "Amount",
          "Responsible",
          "Status",
          "Raised",
        ]}
        isEmpty={filtered.length === 0}
        emptyMessage={
          rows.length === 0
            ? "No exceptions are attributed to this PFA."
            : "No exceptions match your search."
        }
      >
        {filtered.map((e) => (
          <tr key={e._id} className="border-t border-border/50">
            <td className="px-3 py-2.5 font-mono text-xs">{e.exceptionRef}</td>
            <td className="px-3 py-2.5 text-sm">{e.employerName}</td>
            <td className="px-3 py-2.5">
              <Badge variant="outline">{e.type.replace(/_/g, " ")}</Badge>
            </td>
            <td className="max-w-md px-3 py-2.5 text-xs text-muted-foreground">
              {e.description}
            </td>
            <td className="px-3 py-2.5 text-right tabular-nums">
              {e.amount != null ? fmtNaira(e.amount) : "—"}
            </td>
            <td className="px-3 py-2.5 text-xs">{e.responsibleParty}</td>
            <td className="px-3 py-2.5">
              <StatusPill status={e.status} />
            </td>
            <td className="px-3 py-2.5 text-xs text-muted-foreground">
              {fmtDateTime(e.createdAt)}
            </td>
          </tr>
        ))}
      </ClayTable>
    </>
  );
}
