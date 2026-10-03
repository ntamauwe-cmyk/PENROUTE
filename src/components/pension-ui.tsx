import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Download, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { statusTone } from "@/lib/pension";
import { Button } from "@/components/ui/button";

/** CSV cell escaping — quotes commas, quotes and newlines. */
function csvCell(value: string | number): string {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Trigger a client-side CSV download (no server round-trip). */
function downloadCsv(headers: string[], rows: (string | number)[][], name: string) {
  const csv = [headers.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const toneClasses: Record<string, string> = {
  green: "st-green", blue: "st-blue", violet: "st-violet",
  amber: "st-amber", red: "st-red", slate: "st-slate",
};
const toneDot: Record<string, string> = {
  green: "bg-[#007A4D]", blue: "bg-[#2276A8]", violet: "bg-[#5B60A8]",
  amber: "bg-[#D4AF37]", red: "bg-[#C4453C]", slate: "bg-[#8299A5]",
};

export function StatusPill({ status, pulse = false }: { status: string; pulse?: boolean }) {
  const tone = statusTone(status);
  return (
    <span className={`pill ${toneClasses[tone]}`}>
      <span className={`pill-dot ${toneDot[tone]} ${pulse ? "pulse-dot" : ""}`} />
      {statusLabelShort(status)}
    </span>
  );
}

function statusLabelShort(status: string): string {
  const labels: Record<string, string> = {
    awaiting_payment: "Awaiting payment",
    awaiting_ack: "Awaiting PFA ack",
    partially_settled: "Partially settled",
    partially_allocated: "Partially allocated",
    reconciliation_pending: "Recon pending",
  };
  return labels[status] ?? status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function ClayTable({
  headers,
  children,
  emptyMessage,
  isEmpty,
  exportRows,
  exportName,
}: {
  headers: string[];
  children: ReactNode;
  emptyMessage: string;
  isEmpty: boolean;
  exportRows?: (string | number)[][];
  exportName?: string;
}) {
  if (isEmpty) {
    return (
      <div className="pen-card p-8 text-center text-sm text-muted-foreground">{emptyMessage}</div>
    );
  }
  return (
    <div className="pen-card overflow-x-auto p-1.5">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            {headers.map((h, i) => (
              <th key={i} className={`px-3 py-2.5 font-semibold ${i > 1 ? "whitespace-nowrap" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {exportRows && exportName && (
        <div className="flex items-center justify-end p-2 no-print">
          <Button
            size="sm"
            variant="outline"
            className="text-xs font-semibold"
            onClick={() => downloadCsv(headers, exportRows, exportName)}
          >
            <Download className="mr-1.5 size-3.5" /> Export CSV
          </Button>
        </div>
      )}
    </div>
  );
}

export function LoadingBlock({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="pen-card flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> {label}
    </div>
  );
}

export function StatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="pen-card p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums tracking-tight ${tone ?? ""}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

/** Employer + live dashboard data shared across all menu pages. */
export function useEmployer() {
  const dash = useQuery(api.pension.getEmployerDashboard);
  return {
    dash,
    employer: dash?.employer ?? null,
    batches: dash?.batches ?? [],
    loading: dash === undefined,
    needsSeed: dash !== undefined && !dash?.employer,
  };
}
