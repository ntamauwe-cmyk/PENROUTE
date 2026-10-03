import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
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
import { ClayTable, LoadingBlock, PageHeader, StatTile } from "@/components/pension-ui";
import { fmtDateTime, fmtNaira } from "@/lib/pension";
import type { Id } from "@/convex/_generated/dataModel";
import { CheckCircle2, Loader2, Plus, Receipt, Save, XCircle } from "lucide-react";
import { toast } from "sonner";

/**
 * ADMINISTRATOR-ONLY PRICING MANAGEMENT — processing-fee tiers, subscription
 * plans, employer assignments, pricing history and the audit trail.
 *
 * Route guard: every query/mutation here throws for non-admins; the role
 * check runs BEFORE mounting the body (same pattern as the admin console),
 * so ordinary employers never see pricing controls.
 */
export default function AdminPricing() {
  const { user } = useAuth();
  const pricing = useQuery(api.pricing.getPricingForAdmin);
  const audit = useQuery(api.pricing.getPricingAudit);

  const initialize = useMutation(api.pricing.initializePricing);
  const createTier = useMutation(api.pricing.createTier);
  const updateTier = useMutation(api.pricing.updateTier);
  const setTierActive = useMutation(api.pricing.setTierActive);
  const createPlan = useMutation(api.pricing.createPlan);
  const updatePlan = useMutation(api.pricing.updatePlan);
  const setPlanActive = useMutation(api.pricing.setPlanActive);
  const assignSubscription = useMutation(api.pricing.assignSubscription);
  const cancelSubscription = useMutation(api.pricing.cancelSubscription);

  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current || user?.role !== "admin") return;
    initRef.current = true;
    initialize().catch((e) => {
      toast.error(e instanceof Error ? e.message : "Could not initialise pricing");
    });
  }, [user, initialize]);

  // New-tier form
  const [ntLabel, setNtLabel] = useState("");
  const [ntMin, setNtMin] = useState("");
  const [ntMax, setNtMax] = useState("");
  const [ntFee, setNtFee] = useState("");
  // Inline tier editing
  const [editingId, setEditingId] = useState<Id<"pricingTiers"> | null>(null);
  const [edLabel, setEdLabel] = useState("");
  const [edMin, setEdMin] = useState("");
  const [edMax, setEdMax] = useState("");
  const [edFee, setEdFee] = useState("");
  // Plan price editing (planId → naira string)
  const [planPrices, setPlanPrices] = useState<Record<string, string>>({});
  // New plan form
  const [npCode, setNpCode] = useState("");
  const [npName, setNpName] = useState("");
  const [npPrice, setNpPrice] = useState("");
  const [npFrom, setNpFrom] = useState(false);
  // Subscription assignment
  const [asEmployer, setAsEmployer] = useState("");
  const [asPlan, setAsPlan] = useState("");
  const [busy, setBusy] = useState(false);

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
        <PageHeader title="Pricing" />
        <div className="pen-card p-8 text-center text-sm text-muted-foreground">
          Administrator access is required to manage pricing.
        </div>
      </DashboardShell>
    );
  }
  if (!pricing) {
    return (
      <DashboardShell>
        <LoadingBlock label="Loading pricing…" />
      </DashboardShell>
    );
  }

  const activeTierCodes = new Set(
    pricing.tiers
      .filter((t) => t.active && !t.effectiveTo)
      .map((t) => t.code),
  );
  const activeTiers = pricing.tiers
    .filter((t) => activeTierCodes.has(t.code))
    .sort((a, b) => a.minEmployees - b.minEmployees);
  const superseded = pricing.tiers.filter((t) => !activeTierCodes.has(t.code));

  const run = async (fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(okMsg);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const submitNewTier = () =>
    run(async () => {
      const min = Number(ntMin);
      const max = ntMax.trim() === "" ? undefined : Number(ntMax);
      const fee = Math.round(Number(ntFee) * 100); // naira → kobo
      await createTier({
        label: ntLabel,
        minEmployees: min,
        maxEmployees: max,
        feePerPostingKobo: fee,
      });
      setNtLabel("");
      setNtMin("");
      setNtMax("");
      setNtFee("");
    }, "Pricing tier created");

  const submitEditTier = () =>
    run(async () => {
      if (!editingId) return;
      const max = edMax.trim() === "" ? null : Number(edMax);
      await updateTier({
        tierId: editingId,
        label: edLabel,
        minEmployees: Number(edMin),
        maxEmployees: max,
        feePerPostingKobo: Math.round(Number(edFee) * 100),
      });
      setEditingId(null);
    }, "Tier updated — new version effective immediately");

  return (
    <DashboardShell>
      <PageHeader
        title="Pricing & billing configuration"
        description="Central processing-fee tiers and platform subscription plans. Changes are versioned, take effect immediately, and are fully audited — completed transactions keep their original pricing."
      />

      {/* ---------------- Active rate card ---------------- */}
      <section className="pen-card-lg p-6">
        <div className="mb-4 flex items-center gap-2">
          <Receipt className="size-5 text-[#007A4D]" />
          <h2 className="text-sm font-bold tracking-tight">Active processing-fee tiers</h2>
          <Badge className="bg-[#E6F6EF] text-[#04593A]">{activeTiers.length} active</Badge>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {activeTiers.map((t) => (
            <div key={String(t._id)} className="rounded-lg border border-border/60 bg-[#F7F9F8] p-4">
              <p className="text-xs font-semibold text-[#5A6B74]">{t.label}</p>
              <p className="mt-1 text-xl font-bold tabular-nums text-[#0B1F2A]">
                {fmtNaira(t.feePerPostingKobo)}
              </p>
              <p className="text-[11px] text-muted-foreground">per employee posting</p>
            </div>
          ))}
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Subscription plans"
            value={String(pricing.plans.filter((p) => p.active).length)}
            sub="available (optional — employers are not forced to subscribe)"
          />
          <StatTile
            label="Active assignments"
            value={String(pricing.subscriptions.filter((s) => s.status === "active").length)}
            sub="employers on a plan"
          />
          <StatTile
            label="Historical tier versions"
            value={String(superseded.length)}
            sub="superseded rates kept for history"
          />
          <StatTile
            label="Pricing changes"
            value={String((audit ?? []).length)}
            sub="audited entries (who / when / what)"
          />
        </div>
      </section>

      {/* ---------------- Tier management ---------------- */}
      <section className="pen-card-lg p-6">
        <h2 className="mb-4 text-sm font-bold tracking-tight">Fee tier management</h2>
        <ClayTable
          headers={[
            "Range",
            "Fee / posting",
            "Status",
            "Effective from",
            "Effective to",
            "Changed by",
            "Actions",
          ]}
          isEmpty={pricing.tiers.length === 0}
          emptyMessage="No tiers yet — defaults are initialising."
        >
          {pricing.tiers
            .slice()
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((t) => {
              const isActive = activeTierCodes.has(t.code);
              const editing = editingId === t._id;
              return (
                <tr key={String(t._id)} className="pen-table-row">
                  <td className="px-3 py-2.5">
                    {editing ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          className="h-8 w-40"
                          value={edLabel}
                          onChange={(e) => setEdLabel(e.target.value)}
                          aria-label="Tier label"
                        />
                        <Input
                          className="h-8 w-20"
                          value={edMin}
                          onChange={(e) => setEdMin(e.target.value)}
                          aria-label="Min employees"
                        />
                        <Input
                          className="h-8 w-20"
                          placeholder="max (∞)"
                          value={edMax}
                          onChange={(e) => setEdMax(e.target.value)}
                          aria-label="Max employees"
                        />
                      </div>
                    ) : (
                      <span className="text-sm font-medium">{t.label}</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 tabular-nums">
                    {editing ? (
                      <Input
                        className="h-8 w-24"
                        value={edFee}
                        onChange={(e) => setEdFee(e.target.value)}
                        aria-label="Fee per posting (₦)"
                      />
                    ) : (
                      <span className="font-semibold">{fmtNaira(t.feePerPostingKobo)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {isActive ? (
                      <Badge className="bg-[#E6F6EF] text-[#04593A]">
                        {t.active ? "Active" : "Effective"}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        {t.active ? "Scheduled" : "Superseded"}
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {fmtDateTime(t.effectiveFrom)}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {t.effectiveTo ? fmtDateTime(t.effectiveTo) : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {t.createdBy ?? "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    {editing ? (
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          className="h-8 text-xs"
                          disabled={busy}
                          onClick={submitEditTier}
                        >
                          {busy ? (
                            <Loader2 className="mr-1 size-3 animate-spin" />
                          ) : (
                            <Save className="mr-1 size-3" />
                          )}
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 text-xs"
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : isActive ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs"
                        onClick={() => {
                          setEditingId(t._id);
                          setEdLabel(t.label);
                          setEdMin(String(t.minEmployees));
                          setEdMax(t.maxEmployees == null ? "" : String(t.maxEmployees));
                          setEdFee((t.feePerPostingKobo / 100).toString());
                        }}
                      >
                        Edit
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await setTierActive({ tierId: t._id, active: true });
                          }, "Tier reactivated")
                        }
                      >
                        Reactivate
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
        </ClayTable>

        {/* Add tier */}
        <div className="mt-5 rounded-lg border border-dashed border-border/80 p-4">
          <p className="mb-3 flex items-center gap-2 text-xs font-bold text-[#5A6B74]">
            <Plus className="size-3.5" /> ADD A NEW TIER
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <Label className="text-xs">Label</Label>
              <Input
                className="mt-1 h-9"
                placeholder="e.g. 10,001–25,000 employees"
                value={ntLabel}
                onChange={(e) => setNtLabel(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Min employees</Label>
              <Input
                className="mt-1 h-9"
                placeholder="1"
                value={ntMin}
                onChange={(e) => setNtMin(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Max employees (blank = open)</Label>
              <Input
                className="mt-1 h-9"
                placeholder="∞"
                value={ntMax}
                onChange={(e) => setNtMax(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Fee per posting (₦)</Label>
              <Input
                className="mt-1 h-9"
                placeholder="e.g. 7.50"
                value={ntFee}
                onChange={(e) => setNtFee(e.target.value)}
              />
            </div>
            <div className="flex items-end">
              <Button
                className="h-9 w-full bg-[#007A4D] font-semibold hover:bg-[#006A43]"
                disabled={busy || !ntLabel || !ntMin || !ntFee}
                onClick={submitNewTier}
              >
                Create tier
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- Subscription plans ---------------- */}
      <section className="pen-card-lg p-6">
        <h2 className="mb-1 text-sm font-bold tracking-tight">Platform subscription plans</h2>
        <p className="mb-4 text-xs text-muted-foreground">
          Optional layer — employers are only charged when an administrator
          assigns them a plan. Prices below are the defaults; edit any value.
        </p>
        <ClayTable
          headers={["Plan", "Monthly price", "Status", "Actions"]}
          isEmpty={pricing.plans.length === 0}
          emptyMessage="No plans configured."
        >
          {pricing.plans.map((p) => (
            <tr key={String(p._id)} className="pen-table-row">
              <td className="px-3 py-2.5">
                <p className="text-sm font-semibold">{p.name}</p>
                <p className="text-xs text-muted-foreground">{p.description}</p>
              </td>
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Input
                    className="h-8 w-28"
                    value={planPrices[String(p._id)] ?? (p.monthlyPriceKobo / 100).toString()}
                    onChange={(e) =>
                      setPlanPrices((s) => ({ ...s, [String(p._id)]: e.target.value }))
                    }
                    aria-label={`${p.name} monthly price (₦)`}
                  />
                  <span className="text-xs text-muted-foreground">
                    /month{p.priceIsFrom ? " (from)" : ""}
                  </span>
                </div>
              </td>
              <td className="px-3 py-2.5">
                <Badge
                  className={
                    p.active ? "bg-[#E6F6EF] text-[#04593A]" : "bg-[#FBEAE8] text-[#8A2F28]"
                  }
                >
                  {p.active ? "Enabled" : "Disabled"}
                </Badge>
              </td>
              <td className="px-3 py-2.5">
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const entered = planPrices[String(p._id)];
                        const price =
                          entered === undefined
                            ? p.monthlyPriceKobo
                            : Math.round(Number(entered) * 100);
                        await updatePlan({
                          planId: p._id,
                          monthlyPriceKobo:
                            Number.isFinite(price) && price >= 0 ? price : p.monthlyPriceKobo,
                        });
                      }, "Plan price updated")
                    }
                  >
                    <Save className="mr-1 size-3" /> Save price
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 text-xs"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await setPlanActive({ planId: p._id, active: !p.active });
                      }, p.active ? "Plan disabled" : "Plan enabled")
                    }
                  >
                    {p.active ? (
                      <>
                        <XCircle className="mr-1 size-3" /> Disable
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="mr-1 size-3" /> Enable
                      </>
                    )}
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </ClayTable>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <Label className="text-xs">Code</Label>
            <Input
              className="mt-1 h-9"
              placeholder="e.g. growth"
              value={npCode}
              onChange={(e) => setNpCode(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs">Name</Label>
            <Input
              className="mt-1 h-9"
              placeholder="e.g. Growth"
              value={npName}
              onChange={(e) => setNpName(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs">Monthly price (₦)</Label>
            <Input
              className="mt-1 h-9"
              placeholder="e.g. 40000"
              value={npPrice}
              onChange={(e) => setNpPrice(e.target.value)}
            />
          </div>
          <label className="flex items-end gap-2 pb-2 text-xs">
            <input
              type="checkbox"
              checked={npFrom}
              onChange={(e) => setNpFrom(e.target.checked)}
              className="size-4 accent-[#007A4D]"
            />
            “From” price
          </label>
          <div className="flex items-end">
            <Button
              variant="outline"
              className="h-9 w-full font-semibold"
              disabled={busy || !npCode || !npName || !npPrice}
              onClick={() =>
                run(async () => {
                  await createPlan({
                    code: npCode,
                    name: npName,
                    monthlyPriceKobo: Math.round(Number(npPrice) * 100),
                    priceIsFrom: npFrom,
                  });
                  setNpCode("");
                  setNpName("");
                  setNpPrice("");
                  setNpFrom(false);
                }, "Plan created")
              }
            >
              Create plan
            </Button>
          </div>
        </div>
      </section>

      {/* ---------------- Employer assignments ---------------- */}
      <section className="pen-card-lg p-6">
        <h2 className="mb-4 text-sm font-bold tracking-tight">Employer subscriptions</h2>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="min-w-56">
            <Label className="text-xs">Employer</Label>
            <Select value={asEmployer} onValueChange={setAsEmployer}>
              <SelectTrigger className="mt-1 h-9">
                <SelectValue placeholder="Select employer" />
              </SelectTrigger>
              <SelectContent>
                {pricing.employers.map((e) => (
                  <SelectItem key={String(e.employerId)} value={String(e.employerId)}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-44">
            <Label className="text-xs">Plan</Label>
            <Select value={asPlan} onValueChange={setAsPlan}>
              <SelectTrigger className="mt-1 h-9">
                <SelectValue placeholder="Select plan" />
              </SelectTrigger>
              <SelectContent>
                {pricing.plans
                  .filter((p) => p.active)
                  .map((p) => (
                    <SelectItem key={String(p._id)} value={p.code}>
                      {p.name} — ₦{(p.monthlyPriceKobo / 100).toLocaleString()}
                      {p.priceIsFrom ? "+" : ""}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            className="h-9 bg-[#007A4D] font-semibold hover:bg-[#006A43]"
            disabled={busy || !asEmployer || !asPlan}
            onClick={() =>
              run(async () => {
                await assignSubscription({
                  employerId: asEmployer as Id<"employers">,
                  planCode: asPlan,
                });
                setAsEmployer("");
                setAsPlan("");
              }, "Subscription assigned")
            }
          >
            Assign plan
          </Button>
        </div>

        <ClayTable
          headers={["Employer", "Plan", "Monthly price", "Status", "Started", "Actions"]}
          isEmpty={pricing.subscriptions.length === 0}
          emptyMessage="No employer subscriptions — subscriptions are optional and never applied automatically."
        >
          {pricing.subscriptions.map((s) => (
            <tr key={String(s._id)} className="pen-table-row">
              <td className="px-3 py-2.5 text-sm font-medium">{s.employerName}</td>
              <td className="px-3 py-2.5 text-sm">{s.planName}</td>
              <td className="px-3 py-2.5 tabular-nums">
                {fmtNaira(s.monthlyPriceKobo)}/mo
              </td>
              <td className="px-3 py-2.5">
                <Badge
                  className={
                    s.status === "active"
                      ? "bg-[#E6F6EF] text-[#04593A]"
                      : "bg-[#F0F4F4] text-[#5A6B74]"
                  }
                >
                  {s.status}
                </Badge>
              </td>
              <td className="px-3 py-2.5 text-xs text-muted-foreground">
                {fmtDateTime(s.startedAt)}
              </td>
              <td className="px-3 py-2.5">
                {s.status === "active" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 text-xs text-destructive"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await cancelSubscription({ employerId: s.employerId });
                      }, "Subscription cancelled")
                    }
                  >
                    Cancel
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </ClayTable>
      </section>

      {/* ---------------- Pricing history & audit ---------------- */}
      <section className="pen-card-lg p-6">
        <h2 className="mb-4 text-sm font-bold tracking-tight">
          Pricing change history & audit trail
        </h2>
        <ClayTable
          headers={["When", "Actor", "Action", "Change", "Details"]}
          isEmpty={(audit ?? []).length === 0}
          emptyMessage="No pricing changes recorded yet."
        >
          {(audit ?? []).map((a) => (
            <tr key={a._id} className="pen-table-row">
              <td className="px-3 py-2.5 text-xs text-muted-foreground">
                {fmtDateTime(a.createdAt)}
              </td>
              <td className="px-3 py-2.5 text-xs font-medium">{a.actor}</td>
              <td className="px-3 py-2.5">
                <Badge variant="outline" className="text-xs">
                  {a.action.replace(/_/g, " ")}
                </Badge>
              </td>
              <td className="px-3 py-2.5 text-xs">
                {a.field ? (
                  <span className="font-mono">
                    {a.before ?? "—"} → {a.after ?? "—"}
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td className="px-3 py-2.5 text-xs text-muted-foreground">{a.details}</td>
            </tr>
          ))}
        </ClayTable>
      </section>
    </DashboardShell>
  );
}
