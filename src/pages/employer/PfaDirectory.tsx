import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DashboardShell } from "@/components/DashboardShell";
import { ClayTable, LoadingBlock, PageHeader, StatTile } from "@/components/pension-ui";
import { Building2, Landmark, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

export default function PfaDirectory() {
  const pfas = useQuery(api.pension.listPfas);
  const employees = useQuery(api.pension.listEmployerEmployees);
  const sync = useMutation(api.pension.syncPfaDirectory);

  // Employees currently assigned per PFA (this employer's distribution).
  const perPfaCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of employees ?? []) {
      m.set(e.pfaCode, (m.get(e.pfaCode) ?? 0) + 1);
    }
    return m;
  }, [employees]);

  const activeCount = useMemo(
    () => (employees ?? []).filter((e) => e.active).length,
    [employees],
  );

  if (!pfas || !employees) {
    return (
      <DashboardShell>
        <LoadingBlock label="Loading PFA directory…" />
      </DashboardShell>
    );
  }

  const connected = pfas.filter((p: any) => (perPfaCounts.get(p.code) ?? 0) > 0);
  const handleSync = async () => {
    try {
      const r = await sync({});
      toast.success(
        r.inserted + r.updated > 0
          ? `PFA directory synced — ${r.total} licensed PFAs available`
          : `PFA directory already up to date (${r.total} PFAs)`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    }
  };

  return (
    <DashboardShell>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title="Pension Fund Administrators"
          description="The complete directory of licensed PFAs in Nigeria, plus the ones receiving your contributions."
        />
        <Button variant="outline" size="sm" onClick={handleSync} className="shrink-0">
          <RefreshCw className="mr-1.5 size-3.5" /> Sync directory
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Licensed PFAs" value={String(pfas.length)} />
        <StatTile label="Receiving your contributions" value={String(connected.length)} />
        <StatTile label="Employees assigned" value={String(activeCount)} />
        <StatTile label="Integration mode" value="Sandbox" />
      </div>

      {connected.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Receiving your contributions
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {connected.map((p: any) => (
              <div key={p._id} className="pen-card p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#E6F6EF]">
                      <Landmark className="size-4 text-[#007A4D]" />
                    </span>
                    <div>
                      <p className="text-sm font-semibold leading-tight">{p.name}</p>
                      <p className="font-mono text-xs text-muted-foreground">Code {p.code}</p>
                    </div>
                  </div>
                  <Badge className="bg-[#E6F6EF] text-[#04593A]">
                    {perPfaCounts.get(p.code)} emp
                  </Badge>
                </div>
                <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ShieldCheck className="size-3.5 text-[#007A4D]" />
                  Sandbox adapter — settlement + posting simulated pending live integration
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Full directory ({pfas.length} licensed PFAs)
        </h2>
        <ClayTable
          headers={["PFA", "Code", "Your employees", "Integration", ""]}
          isEmpty={pfas.length === 0}
          emptyMessage="No PFAs configured yet — use “Sync directory”."
        >
          {pfas.map((p: any) => {
            const n = perPfaCounts.get(p.code) ?? 0;
            return (
              <tr key={p._id} className="border-t border-border/50">
                <td className="px-3 py-2.5">
                  <span className="inline-flex items-center gap-2 font-medium">
                    {n > 0 ? (
                      <Landmark className="size-4 text-[#007A4D]" />
                    ) : (
                      <Building2 className="size-4 text-muted-foreground/50" />
                    )}
                    {p.name}
                  </span>
                </td>
                <td className="px-3 py-2.5 font-mono text-xs">{p.code}</td>
                <td className="px-3 py-2.5">
                  {n > 0 ? (
                    <Badge className="bg-[#E6F6EF] text-[#04593A]">{n}</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  {p.integrationMode === "sandbox_adapter" ? (
                    <Badge variant="secondary">Sandbox adapter</Badge>
                  ) : (
                    <Badge className="bg-[#E6F6EF] text-[#04593A]">
                      <ShieldCheck className="size-3" /> Live integration
                    </Badge>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right text-xs text-muted-foreground">
                  {n > 0
                    ? "Receiving your monthly contributions"
                    : "Available for assignment — no employees yet"}
                </td>
              </tr>
            );
          })}
        </ClayTable>
      </section>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Codes are Penroute reference codes for routing and integration configuration — official
        PENCOM licence numbers are held by each administrator. Every PFA runs through a
        clearly-labelled sandbox adapter until a live integration is approved and connected.
      </p>
    </DashboardShell>
  );
}
