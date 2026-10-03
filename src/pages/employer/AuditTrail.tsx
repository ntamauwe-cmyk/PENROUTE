import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { DashboardShell } from "@/components/DashboardShell";
import { ClayTable, LoadingBlock, PageHeader } from "@/components/pension-ui";
import { fmtDateTime } from "@/lib/pension";
import { Search } from "lucide-react";

export default function AuditTrail() {
  const logs = useQuery(api.pension.listEmployerAudit);
  const [search, setSearch] = useState("");

  const filtered = useMemo(
    () =>
      (logs ?? []).filter(
        (l: any) =>
          l.action.toLowerCase().includes(search.toLowerCase()) ||
          (l.actor ?? "").toLowerCase().includes(search.toLowerCase()) ||
          (l.details ?? "").toLowerCase().includes(search.toLowerCase()),
      ),
    [logs, search],
  );

  return (
    <DashboardShell>
      <PageHeader
        title="Audit Trail"
        description="Immutable record of every action on your workspace — who, what, when."
      />

      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search actions, actors or details…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {!logs ? (
        <LoadingBlock label="Loading audit trail…" />
      ) : (
        <ClayTable
          headers={["When", "Actor", "Action", "Details"]}
          isEmpty={filtered.length === 0}
          emptyMessage="No audit entries yet."
        >
          {filtered.map((l: any) => (
            <tr key={l._id} className="pen-table-row">
              <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">
                {fmtDateTime(l.createdAt)}
              </td>
              <td className="px-3 py-2.5 text-sm">{l.actor}</td>
              <td className="px-3 py-2.5">
                <Badge variant="secondary">{l.action.replace(/_/g, " ")}</Badge>
              </td>
              <td className="max-w-lg px-3 py-2.5 text-xs text-muted-foreground">
                {l.details ?? "—"}
                {l.entityId && (
                  <span className="ml-1 font-mono text-[10px] opacity-70">[{l.entityId}]</span>
                )}
              </td>
            </tr>
          ))}
        </ClayTable>
      )}
    </DashboardShell>
  );
}
