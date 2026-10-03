import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useNavigate, useParams } from "react-router";
import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { ClayTable, LoadingBlock, PageHeader, StatTile, StatusPill } from "@/components/pension-ui";
import { fmtDate, fmtNaira } from "@/lib/pension";
import {
  ArrowLeft,
  Building2,
  Globe,
  Mail,
  MapPin,
  PauseCircle,
  Pencil,
  Phone,
  PlayCircle,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

const INTEGRATION_OPTIONS = [
  { value: "not_integrated", label: "Not Integrated" },
  { value: "sandbox", label: "Sandbox" },
  { value: "pending_approval", label: "Pending Approval" },
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

function SectionCard({
  title,
  children,
  actions,
}: {
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="pen-card-lg p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">{title}</h2>
        {actions}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default function PfaDetail() {
  const { pfaId } = useParams<{ pfaId: string }>();
  const me = useQuery(api.users.currentUser);

  if (me === undefined) {
    return (
      <DashboardShell>
        <LoadingBlock label="Checking access…" />
      </DashboardShell>
    );
  }

  if (!me || me.role !== "admin") {
    return (
      <DashboardShell>
        <PageHeader title="PFA detail" />
        <div className="pen-card p-8 text-center text-sm text-muted-foreground">
          Administrator access is required to view PFA operational detail.
        </div>
      </DashboardShell>
    );
  }

  return <PfaDetailBody pfaId={pfaId as Id<"pfas">} />;
}

function PfaDetailBody({ pfaId }: { pfaId: Id<"pfas"> }) {
  const navigate = useNavigate();
  const detail = useQuery(api.pfaDirectory.getDetail, { pfaId });
  const setPfaStatus = useMutation(api.pfaDirectory.setPfaStatus);
  const updateMetadata = useMutation(api.pfaDirectory.updatePfaMetadata);
  const setIntegrationStatus = useMutation(api.pfaDirectory.setIntegrationStatus);

  const [editOpen, setEditOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  if (!detail) {
    return (
      <DashboardShell>
        <LoadingBlock label="Loading PFA detail…" />
      </DashboardShell>
    );
  }

  const { pfa, stats, employers, transactionHistory, reconciliationHistory, exceptions, integration } = detail;
  const isActive = pfa.active && pfa.status !== "INACTIVE";

  const openEdit = () => {
    setForm({
      shortName: pfa.shortName ?? "",
      legalName: pfa.legalName ?? "",
      websiteUrl: pfa.websiteUrl ?? "",
      supportEmail: pfa.supportEmail ?? "",
      supportPhone: pfa.supportPhone ?? "",
      headquartersAddress: pfa.headquartersAddress ?? "",
    });
    setError(null);
    setEditOpen(true);
  };

  const saveEdit = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateMetadata({ pfaId, ...form });
      toast.success("PFA details saved");
      setEditOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async () => {
    setBusy(true);
    try {
      await setPfaStatus({ pfaId, active: !isActive });
      toast.success(`${pfa.name} ${isActive ? "deactivated" : "activated"}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  const changeIntegrationStatus = async (value: string) => {
    try {
      await setIntegrationStatus({
        pfaId,
        integrationStatus: value as (typeof INTEGRATION_OPTIONS)[number]["value"],
      });
      toast.success(`Integration status set to ${INTEGRATION_OPTIONS.find((o) => o.value === value)?.label}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    }
  };

  return (
    <DashboardShell>
      <button
        onClick={() => navigate("/dashboard/pfas")}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground no-print"
      >
        <ArrowLeft className="size-4" /> Back to PFA directory
      </button>

      <PageHeader
        title={pfa.name}
        description={pfa.legalName && pfa.legalName !== pfa.name ? pfa.legalName : `PFA ID ${pfa.slug ?? "—"} · Penroute reference code ${pfa.code}`}
        actions={
          <div className="flex flex-wrap items-center gap-2 no-print">
            <Button variant="outline" size="sm" onClick={openEdit}>
              <Pencil className="mr-1.5 size-3.5" /> Edit details
            </Button>
            <Button variant={isActive ? "outline" : "default"} size="sm" disabled={busy} onClick={toggleStatus}>
              {isActive ? (
                <>
                  <PauseCircle className="mr-1.5 size-3.5" /> Deactivate
                </>
              ) : (
                <>
                  <PlayCircle className="mr-1.5 size-3.5" /> Activate
                </>
              )}
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        {isActive ? (
          <Badge className="bg-[#E6F6EF] text-[#04593A]">Active</Badge>
        ) : (
          <Badge variant="secondary">Inactive</Badge>
        )}
        {pfa.pencomStatus === "LICENSED" && (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#007A4D]">
            <ShieldCheck className="size-3.5" /> PenCom status: LICENSED
          </span>
        )}
        <IntegrationBadge status={integration.status} />
      </div>

      {/* Key numbers — real backend values */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatTile label="Employers" value={String(stats.employersCount)} />
        <StatTile label="Employees" value={String(stats.employeesCount)} />
        <StatTile label="Contribution volume" value={fmtNaira(stats.totalContributed)} />
        <StatTile label="Transactions" value={String(stats.settlementCount)} />
        <StatTile label="Last contribution" value={fmtDate(stats.lastContributionAt ?? undefined)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Verified information"
          actions={
            <Button variant="ghost" size="sm" onClick={openEdit} className="no-print">
              <Pencil className="mr-1.5 size-3.5" /> Edit
            </Button>
          }
        >
          <dl className="space-y-3 text-sm">
            <div className="flex items-start gap-2.5">
              <Globe className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Website</dt>
                <dd>{pfa.websiteUrl ?? <span className="text-muted-foreground">Not published — add verified website</span>}</dd>
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Support email</dt>
                <dd>{pfa.supportEmail ?? <span className="text-muted-foreground">Not verified</span>}</dd>
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <Phone className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Support phone</dt>
                <dd>{pfa.supportPhone ?? <span className="text-muted-foreground">Not verified</span>}</dd>
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Headquarters</dt>
                <dd>{pfa.headquartersAddress ?? <span className="text-muted-foreground">Not verified</span>}</dd>
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <Building2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Legal name</dt>
                <dd>{pfa.legalName ?? pfa.name}</dd>
              </div>
            </div>
          </dl>
        </SectionCard>

        <SectionCard title="Integration configuration">
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold">Integration status</p>
                <p className="text-xs text-muted-foreground">
                  Recorded administratively — this does not create a technical integration.
                </p>
              </div>
              <Select value={integration.status} onValueChange={changeIntegrationStatus}>
                <SelectTrigger className="w-44 cursor-pointer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTEGRATION_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <dl className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-[#F3F7F5] p-3">
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Adapter mode</dt>
                <dd className="mt-0.5 font-medium">
                  {integration.mode === "live_api" ? "Live API" : integration.mode === "manual" ? "Manual" : "Sandbox adapter"}
                </dd>
              </div>
              <div className="rounded-lg bg-[#F3F7F5] p-3">
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Endpoint</dt>
                <dd className="mt-0.5 break-all font-medium">
                  {integration.endpoint ?? <span className="text-muted-foreground">Not configured</span>}
                </dd>
              </div>
              <div className="rounded-lg bg-[#F3F7F5] p-3">
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Credentials</dt>
                <dd className="mt-0.5 font-medium">
                  {integration.hasSecret ? "Stored (write-only — never displayed)" : "None stored"}
                </dd>
              </div>
              <div className="rounded-lg bg-[#F3F7F5] p-3">
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">PFA ID</dt>
                <dd className="mt-0.5 font-mono text-xs font-medium">{pfa.slug ?? "—"}</dd>
              </div>
            </dl>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Penroute does not claim any live PFA integration. Status stays “Not Integrated” until a
              verified integration exists and an administrator records it. Endpoint and secrets are
              configured from the Admin console and never shown here.
            </p>
            <Button variant="outline" size="sm" onClick={() => navigate("/admin")} className="no-print">
              Configure endpoint in Admin console
            </Button>
          </div>
        </SectionCard>
      </div>

      <SectionCard title={`Employers using this PFA (${employers.length})`}>
        {employers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No employers have employees assigned to this PFA yet.</p>
        ) : (
          <div className="space-y-2">
            {employers.map((e) => (
              <div
                key={e.employerId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2.5 text-sm"
              >
                <span className="font-medium">{e.name}</span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant={e.status === "active" ? "default" : "secondary"}>{e.status}</Badge>
                  {e.employeesCount} employee{e.employeesCount === 1 ? "" : "s"}
                </span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title={`Transaction history (${transactionHistory.length})`}>
        <ClayTable
          headers={["Reference", "Batch", "Period", "Employer", "Employees", "Amount", "Status", "Instructed"]}
          isEmpty={transactionHistory.length === 0}
          emptyMessage="No transactions have been processed for this PFA."
        >
          {transactionHistory.map((t) => (
            <tr key={t.settlementId} className="pen-table-row">
              <td className="px-3 py-2.5 font-mono text-xs font-medium">{t.settlementRef}</td>
              <td className="px-3 py-2.5 font-mono text-xs">{t.batchRef}</td>
              <td className="px-3 py-2.5">{t.period}</td>
              <td className="px-3 py-2.5">{t.employerName}</td>
              <td className="px-3 py-2.5 tabular-nums">{t.employeeCount}</td>
              <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{fmtNaira(t.amount)}</td>
              <td className="px-3 py-2.5">
                <StatusPill status={t.status} />
              </td>
              <td className="px-3 py-2.5 text-muted-foreground">{fmtDate(t.instructedAt)}</td>
            </tr>
          ))}
        </ClayTable>
      </SectionCard>

      <SectionCard title={`Reconciliation history (${reconciliationHistory.length})`}>
        <ClayTable
          headers={["Entry", "Narration", "Amount", "Reconciliation", "Date"]}
          isEmpty={reconciliationHistory.length === 0}
          emptyMessage="No ledger activity has been recorded for this PFA."
        >
          {reconciliationHistory.map((l) => (
            <tr key={l.entryRef} className="pen-table-row">
              <td className="px-3 py-2.5 font-mono text-xs">{l.entryRef}</td>
              <td className="px-3 py-2.5">{l.narration}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{fmtNaira(l.amount)}</td>
              <td className="px-3 py-2.5">
                <StatusPill status={l.reconciliationStatus} />
              </td>
              <td className="px-3 py-2.5 text-muted-foreground">{fmtDate(l.entryDate)}</td>
            </tr>
          ))}
        </ClayTable>
        {exceptions.length > 0 && (
          <div className="mt-4 space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Exceptions ({exceptions.length})
            </h3>
            {exceptions.map((x) => (
              <div
                key={x._id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2.5 text-sm"
              >
                <span className="font-mono text-xs">{x.exceptionRef}</span>
                <span className="flex-1 truncate text-muted-foreground">{x.description}</span>
                <StatusPill status={x.status} />
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* Edit verified metadata — admin only */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit {pfa.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {(
              [
                { key: "shortName", label: "Short name" },
                { key: "legalName", label: "Legal name" },
                { key: "websiteUrl", label: "Website (https://…)" },
                { key: "supportEmail", label: "Support email" },
                { key: "supportPhone", label: "Support phone" },
                { key: "headquartersAddress", label: "Headquarters address" },
              ] as const
            ).map((f) => (
              <div key={f.key}>
                <Label>{f.label}</Label>
                <Input
                  className="mt-1.5"
                  value={form[f.key] ?? ""}
                  onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                  placeholder="Leave empty if not verified"
                />
              </div>
            ))}
            {error && <p className="text-xs font-medium text-destructive">{error}</p>}
            <p className="text-xs text-muted-foreground">
              Only record verified information. Empty fields are stored as “not published” — Penroute
              never invents PFA contact details.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveEdit} disabled={busy}>
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardShell>
  );
}
