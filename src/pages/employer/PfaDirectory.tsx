import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useNavigate } from "react-router";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
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
import { DashboardShell } from "@/components/DashboardShell";
import { ClayTable, LoadingBlock, PageHeader, StatTile } from "@/components/pension-ui";
import { fmtDate, fmtNaira } from "@/lib/pension";
import {
  ArrowRight,
  Building2,
  Landmark,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

const FILTERS = [
  { value: "all", label: "All PFAs" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "integrated", label: "Integrated" },
  { value: "not_integrated", label: "Not Integrated" },
  { value: "sandbox", label: "Sandbox" },
  { value: "production", label: "Production" },
] as const;

function IntegrationBadge({ status }: { status: string }) {
  if (status === "production")
    return <Badge className="bg-[#E6F6EF] text-[#04593A]">Production</Badge>;
  if (status === "sandbox") return <Badge className="bg-[#F5EFD9] text-[#7A6412]">Sandbox</Badge>;
  if (status === "pending_approval")
    return <Badge className="bg-[#E8EEF2] text-[#3B5563]">Pending Approval</Badge>;
  return <Badge variant="secondary">Not Integrated</Badge>;
}

export default function PfaDirectory() {
  const navigate = useNavigate();
  const directory = useQuery(api.pfaDirectory.getDirectory);
  const sync = useMutation(api.pension.syncPfaDirectory);
  const setStatus = useMutation(api.pfaDirectory.setPfaStatus);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  const rows = directory?.rows ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((p) => {
      const isActive = p.active && p.status !== "INACTIVE";
      const statusOk =
        filter === "all" ||
        (filter === "active" && isActive) ||
        (filter === "inactive" && !isActive) ||
        (filter === "integrated" && p.integrationStatus !== "not_integrated") ||
        (filter === "not_integrated" && p.integrationStatus === "not_integrated") ||
        (filter === "sandbox" && p.integrationStatus === "sandbox") ||
        (filter === "production" && p.integrationStatus === "production");
      const searchOk =
        !q ||
        p.name.toLowerCase().includes(q) ||
        (p.shortName ?? "").toLowerCase().includes(q) ||
        (p.slug ?? "").toLowerCase().includes(q) ||
        p.code.toLowerCase().includes(q);
      return statusOk && searchOk;
    });
  }, [rows, search, filter]);

  if (!directory) {
    return (
      <DashboardShell>
        <LoadingBlock label="Loading PFA directory…" />
      </DashboardShell>
    );
  }

  const isAdmin = directory.isAdmin;
  const t = directory.totals;

  const handleSync = async () => {
    try {
      const r = await sync({});
      toast.success(
        r.inserted + r.updated > 0
          ? `Directory updated — ${r.total} current licensed PFAs`
          : `Directory already up to date (${r.total} PFAs)`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    }
  };

  const toggleStatus = async (p: (typeof rows)[number]) => {
    setBusyId(p._id);
    try {
      const next = !(p.active && p.status !== "INACTIVE");
      await setStatus({ pfaId: p._id, active: next });
      toast.success(`${p.name} ${next ? "activated" : "deactivated"}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <DashboardShell>
      <PageHeader
        title="PFA Directory"
        description="Master directory of the 19 current PenCom-licensed Pension Fund Administrators. A PFA listed here is a supported pension destination — it does not imply the PFA has authorised or integrated with Penroute."
        actions={
          isAdmin ? (
            <Button variant="outline" size="sm" onClick={handleSync}>
              <RefreshCw className="mr-1.5 size-3.5" /> Sync directory
            </Button>
          ) : undefined
        }
      />

      {/* Real statistics from the backend */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Active PFAs"
          value={`${t.active} / ${t.total}`}
          sub={`${t.inactive} inactive (legacy)`}
        />
        <StatTile label="PFAs with transactions" value={String(t.pfasWithTransactions)} />
        <StatTile
          label="Not integrated"
          value={String(t.notIntegrated)}
          sub="No live PFA integrations claimed"
        />
        <StatTile
          label="Contributions processed"
          value={fmtNaira(t.totalContributed, { compact: true })}
          sub={isAdmin ? "Platform-wide" : "Your organisation"}
        />
      </div>

      {/* Search + filters */}
      <div className="clay flex flex-wrap items-end gap-4 p-4 no-print">
        <div className="w-full sm:w-72">
          <Label>Search</Label>
          <div className="relative mt-1.5">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="PFA name, short name or PFA ID…"
              className="pl-9"
            />
          </div>
        </div>
        <div className="w-48">
          <Label>Filter</Label>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="mt-1.5 w-full cursor-pointer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILTERS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto text-right">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Showing
          </p>
          <p className="text-lg font-bold tabular-nums">
            {filtered.length}
            <span className="text-sm font-medium text-muted-foreground"> / {rows.length}</span>
          </p>
        </div>
      </div>

      {/* Desktop / tablet: table */}
      <div className="hidden sm:block">
        <ClayTable
          headers={
            isAdmin
              ? ["PFA", "Status", "PenCom", "Employees", "Contributions", "Last transaction", "Integration", ""]
              : ["PFA", "Status", "PenCom", "Employees", "Contributions", "Last transaction", "Integration"]
          }
          isEmpty={filtered.length === 0}
          emptyMessage="No PFAs match the current search or filter."
        >
          {filtered.map((p) => (
            <tr
              key={p._id}
              className="pen-table-row cursor-pointer"
              onClick={() => navigate(`/dashboard/pfas/${p._id}`)}
            >
              <td className="px-3 py-2.5">
                <span className="flex items-center gap-2.5">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#E6F6EF]">
                    <Landmark className="size-4 text-[#007A4D]" />
                  </span>
                  <span>
                    <span className="block font-medium leading-tight">{p.name}</span>
                    <span className="block font-mono text-[11px] text-muted-foreground">
                      {p.slug ?? "—"} · {p.code}
                    </span>
                  </span>
                </span>
              </td>
              <td className="px-3 py-2.5">
                {p.active && p.status !== "INACTIVE" ? (
                  <Badge className="bg-[#E6F6EF] text-[#04593A]">Active</Badge>
                ) : (
                  <Badge variant="secondary">Inactive</Badge>
                )}
              </td>
              <td className="px-3 py-2.5">
                {p.pencomStatus === "LICENSED" ? (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#007A4D]">
                    <ShieldCheck className="size-3.5" /> LICENSED
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-3 py-2.5 tabular-nums">{p.stats.employeesCount}</td>
              <td className="px-3 py-2.5 tabular-nums">
                {p.stats.totalContributed > 0 ? fmtNaira(p.stats.totalContributed) : "—"}
              </td>
              <td className="px-3 py-2.5 text-muted-foreground">
                {fmtDate(p.stats.lastContributionAt ?? undefined)}
              </td>
              <td className="px-3 py-2.5">
                <IntegrationBadge status={p.integrationStatus} />
              </td>
              {isAdmin && (
                <td className="px-3 py-2.5 text-right no-print" onClick={(e) => e.stopPropagation()}>
                  <span className="inline-flex items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === p._id}
                      onClick={() => toggleStatus(p)}
                      title={p.active ? "Deactivate PFA" : "Activate PFA"}
                    >
                      {p.active ? (
                        <>
                          <PauseCircle className="size-3.5" /> Deactivate
                        </>
                      ) : (
                        <>
                          <PlayCircle className="size-3.5" /> Activate
                        </>
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate(`/dashboard/pfas/${p._id}`)}
                    >
                      View <ArrowRight className="size-3.5" />
                    </Button>
                  </span>
                </td>
              )}
            </tr>
          ))}
        </ClayTable>
      </div>

      {/* Mobile: card list instead of a horizontally-scrolling table */}
      <div className="space-y-3 sm:hidden">
        {filtered.length === 0 ? (
          <div className="pen-card p-6 text-center text-sm text-muted-foreground">
            No PFAs match the current search or filter.
          </div>
        ) : (
          filtered.map((p) => (
            <div key={p._id} className="pen-card p-4">
              <button
                className="w-full text-left"
                onClick={() => navigate(`/dashboard/pfas/${p._id}`)}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="flex items-center gap-2.5">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#E6F6EF]">
                      <Landmark className="size-4 text-[#007A4D]" />
                    </span>
                    <span>
                      <span className="block text-sm font-semibold leading-tight">{p.name}</span>
                      <span className="block font-mono text-[11px] text-muted-foreground">
                        {p.slug ?? "—"} · {p.code}
                      </span>
                    </span>
                  </span>
                  <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {p.active && p.status !== "INACTIVE" ? (
                    <Badge className="bg-[#E6F6EF] text-[#04593A]">Active</Badge>
                  ) : (
                    <Badge variant="secondary">Inactive</Badge>
                  )}
                  <IntegrationBadge status={p.integrationStatus} />
                  {p.pencomStatus === "LICENSED" && (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#007A4D]">
                      <ShieldCheck className="size-3.5" /> LICENSED
                    </span>
                  )}
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-border/60 pt-3 text-center">
                  <div>
                    <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Employees
                    </dt>
                    <dd className="text-sm font-bold tabular-nums">{p.stats.employeesCount}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Contributions
                    </dt>
                    <dd className="text-sm font-bold tabular-nums">
                      {p.stats.totalContributed > 0 ? fmtNaira(p.stats.totalContributed, { compact: true }) : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Last
                    </dt>
                    <dd className="text-sm font-bold">
                      {fmtDate(p.stats.lastContributionAt ?? undefined)}
                    </dd>
                  </div>
                </dl>
              </button>
              {isAdmin && (
                <div className="mt-3 border-t border-border/60 pt-3 no-print">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    disabled={busyId === p._id}
                    onClick={() => toggleStatus(p)}
                  >
                    {p.active ? (
                      <>
                        <PauseCircle className="mr-1.5 size-3.5" /> Deactivate PFA
                      </>
                    ) : (
                      <>
                        <PlayCircle className="mr-1.5 size-3.5" /> Activate PFA
                      </>
                    )}
                  </Button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
        <Building2 className="mt-0.5 size-3.5 shrink-0" />
        Codes are Penroute reference codes for internal routing — official PenCom licence numbers are
        held by each administrator. Every PFA defaults to “Not Integrated”; integration status only
        changes when an administrator explicitly records it after a verified integration exists.
      </p>
    </DashboardShell>
  );
}
