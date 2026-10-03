import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DashboardShell } from "@/components/DashboardShell";
import { ClayTable, LoadingBlock, PageHeader, StatTile, StatusPill } from "@/components/pension-ui";
import { fmtDateTime, fmtNaira } from "@/lib/pension";
import type { Id } from "@/convex/_generated/dataModel";
import {
  CheckCircle2,
  Database,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Users,
} from "lucide-react";
import { toast } from "sonner";

/**
 * PLATFORM ADMIN CONSOLE (spec §22, §23) — includes the plug-and-play rail
 * switch: flip collection between the sandbox rail and the live Paystack rail
 * once PAYSTACK_SECRET_KEY is configured in the Keys tab.
 *
 * Route guard: the console's queries are admin-only and THROW for non-admins,
 * so the role check runs BEFORE mounting the body — a friendly access screen
 * instead of a root-boundary crash (which would also expose a stack trace).
 */
export default function AdminConsole() {
  const { user } = useAuth();

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
        <PageHeader title="Admin console" />
        <div className="pen-card p-8 text-center text-sm text-muted-foreground">
          Administrator access is required to use the admin console.
        </div>
      </DashboardShell>
    );
  }
  return <AdminConsoleBody />;
}

function AdminConsoleBody() {
  const overview = useQuery(api.admin.getAdminOverview);
  const employers = useQuery(api.admin.listAllEmployers);
  const exceptions = useQuery(api.admin.listAllExceptions);
  const railStatus = useAction(api.payments.railStatus);

  const updateFee = useMutation(api.admin.adminUpdateFee);
  const setRailMode = useMutation(api.admin.adminSetRailMode);
  const setEmployerStatus = useMutation(api.admin.adminSetEmployerStatus);
  const setPfaIntegration = useMutation(api.admin.adminSetPfaIntegration);
  const clearPfaSecrets = useMutation(api.admin.adminClearPfaSecrets);
  const testConnection = useAction(api.pfaDispatch.testPfaConnection);
  const pfaIntegrations = useQuery(api.admin.adminListPfaIntegrations);

  // PFA portal access provisioning (role "pfa")
  const pfaAccess = useQuery(api.pfaPortal.adminListAccess);
  const allPfas = useQuery(api.pension.listPfas);
  const provisionPfaAccess = useMutation(api.pfaPortal.adminProvisionAccess);
  const revokePfaGrant = useMutation(api.pfaPortal.adminRevokeGrant);
  const unlinkPfaUser = useMutation(api.pfaPortal.adminUnlinkPfaUser);
  const [pfaOperatorEmail, setPfaOperatorEmail] = useState("");
  const [pfaOperatorPfaId, setPfaOperatorPfaId] = useState<string>("");
  const [grantBusy, setGrantBusy] = useState(false);

  // null = no local edit yet — the input shows the server-configured fee.
  const [fee, setFee] = useState<string | null>(null);
  const feeValue = fee ?? String(overview?.feePerEmployeeKobo ?? "");
  const [rail, setRail] = useState<{ mode: string; configured: boolean } | null>(null);
  const [checkingRail, setCheckingRail] = useState(true); // status fetch starts on mount
  const [busy, setBusy] = useState(false);

  // Fetch the payment rail status once on mount. setState only runs inside
  // promise callbacks (async) — never synchronously within the effect.
  const refreshRail = () =>
    railStatus({})
      .then((res) => {
        setRail({ mode: res.mode, configured: res.configured });
      })
      .catch(() => {
        setRail({ mode: "sandbox", configured: false });
      })
      .finally(() => {
        setCheckingRail(false);
      });

  useEffect(() => {
    void refreshRail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flipRail = async (mode: "sandbox" | "live") => {
    if (mode === "live" && rail && !rail.configured) {
      toast.error(
        "PAYSTACK_SECRET_KEY is not configured. Add it in the Keys tab first (sk_test_… or sk_live_…).",
      );
      return;
    }
    setBusy(true);
    try {
      await setRailMode({ mode });
      setCheckingRail(true);
      await refreshRail();
      toast.success(`Payment rail switched to ${mode.toUpperCase()}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not switch rail");
    } finally {
      setBusy(false);
    }
  };

  const grantPfaAccess = async () => {
    if (!pfaOperatorEmail.trim()) {
      toast.error("Enter the operator's email address");
      return;
    }
    if (!pfaOperatorPfaId) {
      toast.error("Select the PFA this operator belongs to");
      return;
    }
    setGrantBusy(true);
    try {
      const res = await provisionPfaAccess({
        email: pfaOperatorEmail.trim(),
        pfaId: pfaOperatorPfaId as Id<"pfas">,
      });
      toast.success(
        res.provisioned === "linked"
          ? "Account linked to the PFA portal"
          : res.provisioned === "invited"
            ? "Invitation stored — activates on their first sign-in"
            : "That email already has access to this PFA",
      );
      setPfaOperatorEmail("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not grant access");
    } finally {
      setGrantBusy(false);
    }
  };

  const saveFee = async () => {
    const n = Number(feeValue);
    if (!Number.isFinite(n) || n < 0) {
      toast.error("Enter a valid fee in kobo (₦9 = 900)");
      return;
    }
    setBusy(true);
    try {
      await updateFee({ perEmployeeFeeKobo: n });
      toast.success(`Fee updated to ₦${(n / 100).toFixed(0)} per employee credit`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  const effectiveMode = rail?.mode ?? overview?.railMode ?? "sandbox";

  return (
    <DashboardShell>
      <PageHeader
        title="Admin console"
        description="Platform-wide operations — pricing, payment rail, employers, exceptions and integration health."
      />

      {!overview ? (
        <LoadingBlock label="Verifying admin access…" />
      ) : (
        <>
          {/* Platform stats */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile label="Employers" value={String(overview.employersCount)} />
            <StatTile label="Batches" value={String(overview.batchesCount)} />
            <StatTile label="Open exceptions" value={String(overview.openExceptions)} />
            <StatTile label="Pension processed" value={fmtNaira(overview.totalPension, { compact: true })} />
            <StatTile label="Platform revenue" value={fmtNaira(overview.totalFees, { compact: true })} />
            <StatTile label="Ledger rows" value={String(overview.ledgerCount)} />
          </section>

          {/* PFA statistics — real database values */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <StatTile
              label="Active PFAs"
              value={`${overview.pfaStats.activePfas} / ${overview.pfaStats.totalPfas}`}
              sub="Current licensed directory"
            />
            <StatTile
              label="PFAs with transactions"
              value={String(overview.pfaStats.pfasWithTransactions)}
            />
            <StatTile
              label="Employees processed"
              value={String(overview.pfaStats.employeesProcessed)}
              sub="Distinct RSA PINs"
            />
            <StatTile
              label="Pending remittances"
              value={String(overview.pfaStats.pendingRemittances)}
            />
            <StatTile
              label="Unreconciled contributions"
              value={String(overview.pfaStats.unreconciledContributions)}
              sub="Batches awaiting reconciliation"
            />
          </section>

          {/* PLUG-AND-PLAY: payment rail switch */}
          <section className="pen-card-lg p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 font-bold tracking-tight">
                  <KeyRound className="size-5 text-primary" /> Payment rail
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Switch collection between the clearly-labelled sandbox rail and the live Paystack
                  rail — no code changes. The ledger only records after the provider verifies payment.
                </p>
              </div>
              <Badge
                className={
                  effectiveMode === "live"
                    ? "bg-[#E6F6EF] text-[#04593A]"
                    : "bg-[#FBF3E0] text-[#7A5A10]"
                }
              >
                {effectiveMode === "live" ? "LIVE (Paystack)" : "SANDBOX (test rail)"}
              </Badge>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCheckingRail(true);
                  void refreshRail();
                }}
                disabled={checkingRail}
              >
                {checkingRail ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                Check key status
              </Button>
              {rail && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {rail.configured ? (
                    <>
                      <CheckCircle2 className="size-4 text-[#007A4D]" />
                      Paystack key detected — ready for live mode
                    </>
                  ) : (
                    <>
                      <TriangleAlert className="size-4 text-[#D4AF37]" />
                      PAYSTACK_SECRET_KEY not set — add it in the Keys tab to enable live mode
                    </>
                  )}
                </span>
              )}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant={effectiveMode === "sandbox" ? "default" : "outline"}
                onClick={() => flipRail("sandbox")}
                disabled={busy || effectiveMode === "sandbox"}
              >
                Use sandbox rail
              </Button>
              <Button
                variant={effectiveMode === "live" ? "default" : "outline"}
                onClick={() => flipRail("live")}
                disabled={busy || effectiveMode === "live"}
              >
                <ShieldCheck className="size-4" /> Go live with Paystack
              </Button>
            </div>
          </section>

          {/* PLUG-AND-PLAY: PFA live integrations */}
          <section className="pen-card-lg p-6">
            <h2 className="flex items-center gap-2 font-bold tracking-tight">
              <ShieldCheck className="size-5 text-primary" /> PFA integrations
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Configure a PFA's approved contribution-file endpoint (https://…) and API secret. From
              then on, every settlement to that PFA is delivered automatically during processing —
              no code changes. Secrets are write-only: once saved they are never displayed again.
            </p>
            {!pfaIntegrations ? (
              <LoadingBlock label="Loading PFA integrations…" />
            ) : (
              <div className="mt-4 space-y-2">
                {pfaIntegrations.map((p) => (
                  <PfaIntegrationRow
                    key={p._id}
                    pfa={p}
                    onSave={async (args) => {
                      await setPfaIntegration({ pfaId: p._id, ...args });
                    }}
                    onClear={async () => {
                      await clearPfaSecrets({ pfaId: p._id });
                    }}
                    onTest={() => testConnection({ pfaId: p._id })}
                  />
                ))}
              </div>
            )}
          </section>

          {/* PFA portal access — role "pfa" provisioning */}
          <section className="pen-card-lg p-6">
            <h2 className="flex items-center gap-2 font-bold tracking-tight">
              <Users className="size-5 text-primary" /> PFA portal access
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Provision a Pension Fund Administrator operator. If the email already has a Penroute
              account it is linked immediately; otherwise an invitation is stored and activated the
              first time they sign in. PFA users only ever see their own PFA's data.
            </p>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <div className="w-64">
                <Label>Operator email</Label>
                <Input
                  className="mt-1.5"
                  type="email"
                  value={pfaOperatorEmail}
                  onChange={(e) => setPfaOperatorEmail(e.target.value)}
                  placeholder="operator@pfa.example"
                />
              </div>
              <div className="w-64">
                <Label>PFA</Label>
                <Select value={pfaOperatorPfaId} onValueChange={setPfaOperatorPfaId}>
                  <SelectTrigger className="mt-1.5 w-full">
                    <SelectValue placeholder="Select a PFA…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(allPfas ?? [])
                      .filter((p) => p.active !== false && p.status !== "INACTIVE")
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((p) => (
                        <SelectItem key={p._id} value={p._id}>
                          {p.name} ({p.code})
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                className="font-semibold"
                onClick={grantPfaAccess}
                disabled={grantBusy}
              >
                {grantBusy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                Grant access
              </Button>
            </div>

            {!pfaAccess ? (
              <div className="mt-4">
                <LoadingBlock label="Loading PFA access…" />
              </div>
            ) : (
              <div className="mt-4">
                <ClayTable
                  headers={["Email", "PFA", "Type", "Status", "Granted", ""]}
                  isEmpty={pfaAccess.linked.length === 0 && pfaAccess.grants.length === 0}
                  emptyMessage="No PFA portal access has been provisioned yet."
                >
                  {[
                    ...pfaAccess.linked.map((l) => ({
                      key: `u-${l.userId}`,
                      email: l.email,
                      pfaName: l.pfaName,
                      type: "Account",
                      status: "linked",
                      createdAt: 0,
                      action: "unlink" as const,
                      actionId: l.userId,
                    })),
                    ...pfaAccess.grants.map((g) => ({
                      key: `g-${g.grantId}`,
                      email: g.email,
                      pfaName: g.pfaName,
                      type: "Invitation",
                      status: g.status,
                      createdAt: g.createdAt,
                      action: g.status === "revoked" ? null : ("revoke" as const),
                      actionId: g.grantId,
                    })),
                  ].map((row) => (
                    <tr key={row.key} className="border-t border-border/50">
                      <td className="px-3 py-2.5 text-sm font-medium">{row.email}</td>
                      <td className="px-3 py-2.5 text-sm">{row.pfaName}</td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">{row.type}</td>
                      <td className="px-3 py-2.5">
                        <Badge
                          variant="secondary"
                          className={
                            row.status === "revoked"
                              ? "bg-[#FBEAE8] text-[#8A2F28]"
                              : row.status === "linked" || row.status === "claimed"
                                ? "bg-[#E6F6EF] text-[#04593A]"
                                : "bg-[#FBF3E0] text-[#7A5A10]"
                          }
                        >
                          {row.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">
                        {row.createdAt ? fmtDateTime(row.createdAt) : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {row.action && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            onClick={async () => {
                              try {
                                if (row.action === "unlink") {
                                  await unlinkPfaUser({ userId: row.actionId as Id<"users"> });
                                  toast.success(`PFA portal access removed for ${row.email}`);
                                } else {
                                  await revokePfaGrant({ grantId: row.actionId as Id<"pfaAccessGrants"> });
                                  toast.success(`Invitation revoked for ${row.email}`);
                                }
                              } catch (err) {
                                toast.error(err instanceof Error ? err.message : "Update failed");
                              }
                            }}
                          >
                            {row.action === "unlink" ? "Unlink" : "Revoke"}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </ClayTable>
              </div>
            )}
          </section>

          {/* Fee management */}
          <section className="pen-card-lg p-6">
            <h2 className="font-bold tracking-tight">Fee management</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Per-employee contribution processing fee. Pension funds and platform revenue stay
              separate in the ledger regardless of pricing.
            </p>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <div className="w-40">
                <Label>Fee (kobo)</Label>
                <Input
                  className="mt-1.5"
                  value={feeValue}
                  onChange={(e) => setFee(e.target.value)}
                  inputMode="numeric"
                  placeholder="900"
                />
              </div>
              <p className="pb-2 text-sm text-muted-foreground">
                = ₦{Number.isFinite(Number(feeValue)) ? (Number(feeValue) / 100).toFixed(0) : "?"} per employee
                credit
              </p>
              <Button className="font-semibold" onClick={saveFee} disabled={busy}>
                Save fee
              </Button>
            </div>
          </section>

          {/* Employers */}
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-bold tracking-tight">
              <Database className="size-4 text-primary" /> Employers
            </h2>
            {!employers ? (
              <LoadingBlock label="Loading employers…" />
            ) : (
              <ClayTable
                headers={["Employer", "RC", "Employees", "Batches", "Processed", "Fees", "Status", ""]}
                isEmpty={employers.length === 0}
                emptyMessage="No employers registered yet."
              >
                {employers.map((e) => (
                  <tr key={e._id} className="border-t border-border/50">
                    <td className="px-3 py-2.5">
                      <p className="font-medium">{e.name}</p>
                      <p className="text-xs text-muted-foreground">{e.contactEmail}</p>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">{e.rcNumber}</td>
                    <td className="px-3 py-2.5 tabular-nums">{e.employees}</td>
                    <td className="px-3 py-2.5 tabular-nums">{e.batches}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtNaira(e.processedKobo)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {fmtNaira(e.feesKobo)}
                    </td>
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
                    <td className="px-3 py-2.5 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            await setEmployerStatus({
                              employerId: e._id,
                              status: e.status === "active" ? "suspended" : "active",
                            });
                            toast.success(`${e.name} ${e.status === "active" ? "suspended" : "reactivated"}`);
                          } catch (err) {
                            toast.error(err instanceof Error ? err.message : "Update failed");
                          }
                        }}
                      >
                        {e.status === "active" ? "Suspend" : "Reactivate"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </ClayTable>
            )}
          </section>

          {/* Exceptions */}
          <section>
            <h2 className="mb-3 text-sm font-bold tracking-tight">Platform exceptions</h2>
            {!exceptions ? (
              <LoadingBlock label="Loading exceptions…" />
            ) : (
              <ClayTable
                headers={["Ref", "Employer", "Type", "Detail", "Amount", "Status", "Raised"]}
                isEmpty={exceptions.length === 0}
                emptyMessage="No exceptions across the platform."
              >
                {exceptions.map((e) => (
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
                    <td className="px-3 py-2.5">
                      <StatusPill status={e.status === "open" ? "exception" : "reconciled"} />
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">
                      {fmtDateTime(e.createdAt)}
                    </td>
                  </tr>
                ))}
              </ClayTable>
            )}
          </section>

          {/* Integration logs */}
          <section>
            <h2 className="mb-3 text-sm font-bold tracking-tight">Recent integration activity</h2>
            <ClayTable
              headers={["Adapter", "Operation", "Request", "Response", "OK", "When"]}
              isEmpty={(overview.recentLogs ?? []).length === 0}
              emptyMessage="No adapter calls yet."
            >
              {(overview.recentLogs ?? []).map((l) => (
                <tr key={l._id} className="border-t border-border/50">
                  <td className="px-3 py-2.5 font-mono text-xs">{l.adapter}</td>
                  <td className="px-3 py-2.5 text-xs font-medium">{l.operation}</td>
                  <td className="max-w-xs px-3 py-2.5 font-mono text-[10px] text-muted-foreground">
                    {l.requestSummary}
                  </td>
                  <td className="max-w-xs px-3 py-2.5 font-mono text-[10px] text-muted-foreground">
                    {l.responseSummary}
                  </td>
                  <td className="px-3 py-2.5">
                    {l.success ? (
                      <CheckCircle2 className="size-4 text-[#007A4D]" />
                    ) : (
                      <TriangleAlert className="size-4 text-[#C4453C]" />
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {fmtDateTime(l.createdAt)}
                  </td>
                </tr>
              ))}
            </ClayTable>
          </section>
        </>
      )}
    </DashboardShell>
  );
}

/** One PFA row in the admin integration config — write-only secret fields. */
function PfaIntegrationRow({
  pfa,
  onSave,
  onClear,
  onTest,
}: {
  pfa: {
    _id: string;
    name: string;
    code: string;
    integrationMode: string;
    hasEndpoint: boolean;
    hasSecret: boolean;
    endpoint: string | null;
  };
  onSave: (args: {
    integrationMode: "sandbox_adapter" | "live_api" | "manual";
    endpoint?: string;
    apiSecret?: string;
    secretHeaderName?: string;
    hmacSecret?: string;
  }) => Promise<void>;
  onClear: () => Promise<void>;
  onTest: () => Promise<{ ok: boolean; reason?: string; httpStatus?: number; response?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [headerName, setHeaderName] = useState("");
  const [hmacSecret, setHmacSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const live = pfa.integrationMode === "live_api";

  const save = async (mode: "sandbox_adapter" | "live_api" | "manual") => {
    setBusy(true);
    try {
      await onSave({
        integrationMode: mode,
        endpoint: endpoint || undefined,
        apiSecret: apiSecret || undefined,
        secretHeaderName: headerName || undefined,
        hmacSecret: hmacSecret || undefined,
      });
      setApiSecret("");
      setHmacSecret("");
      setOpen(false);
      toast.success(`${pfa.name} integration updated`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await onTest();
      setTestResult(
        res.ok
          ? `Endpoint responded HTTP ${res.httpStatus} — reachable`
          : (res.reason ?? `Endpoint test failed${res.httpStatus ? ` (HTTP ${res.httpStatus})` : ""}`),
      );
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : "Connection test failed");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="rounded-xl border border-border/60 bg-white/60">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate font-medium">
            {pfa.name} <span className="ml-1 font-mono text-xs text-muted-foreground">{pfa.code}</span>
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {pfa.endpoint ? pfa.endpoint : "No endpoint configured"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            className={
              live
                ? "bg-[#E6F6EF] text-[#04593A]"
                : pfa.integrationMode === "manual"
                  ? "bg-[#FBF3E0] text-[#7A5A10]"
                  : ""
            }
          >
            {live ? "LIVE API" : pfa.integrationMode === "manual" ? "MANUAL" : "SANDBOX"}
          </Badge>
          {pfa.hasEndpoint && (
            <Button size="sm" variant="outline" onClick={runTest} disabled={testing}>
              {testing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Test
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? "Close" : "Configure"}
          </Button>
        </div>
      </div>
      {testResult && (
        <p
          className={`px-4 pb-2 text-xs ${testResult.includes("reachable") ? "text-[#04593A]" : "text-[#8A2F28]"}`}
        >
          {testResult}
        </p>
      )}
      {open && (
        <div className="space-y-3 border-t border-border/50 px-4 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Contribution endpoint (https://…)</Label>
              <Input
                className="mt-1.5"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder={pfa.endpoint ?? "https://api.pfa.example/contributions"}
              />
            </div>
            <div>
              <Label>Secret header (optional — default Authorization)</Label>
              <Input
                className="mt-1.5"
                value={headerName}
                onChange={(e) => setHeaderName(e.target.value)}
                placeholder="Authorization"
              />
            </div>
            <div>
              <Label>API secret {pfa.hasSecret ? "(stored — enter to replace)" : ""}</Label>
              <Input
                className="mt-1.5"
                type="password"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                placeholder={pfa.hasSecret ? "•••••••• (unchanged)" : "secret from the PFA"}
              />
            </div>
            <div>
              <Label>HMAC shared secret (optional signature header)</Label>
              <Input
                className="mt-1.5"
                type="password"
                value={hmacSecret}
                onChange={(e) => setHmacSecret(e.target.value)}
                placeholder="for X-Penroute-Signature verification"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="font-semibold" onClick={() => save("live_api")} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
              Save & go live
            </Button>
            <Button size="sm" variant="outline" onClick={() => save("sandbox_adapter")} disabled={busy}>
              Save as sandbox
            </Button>
            <Button size="sm" variant="outline" onClick={() => save("manual")} disabled={busy}>
              Mark manual
            </Button>
            {pfa.hasSecret && (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                disabled={busy}
                onClick={async () => {
                  try {
                    await onClear();
                    toast.success("Stored secrets cleared");
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Failed");
                  }
                }}
              >
                Clear secrets
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
