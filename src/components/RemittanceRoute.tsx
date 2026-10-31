import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { friendlyError } from "@/lib/errors";
import { fmtDateTime, fmtNaira } from "@/lib/pension";
import { ArrowLeftRight, CheckCircle2, Copy, Landmark } from "lucide-react";
import { toast } from "sonner";

/** Convex HTTP actions are served from the deployment's ".site" host. */
function siteUrl(): string {
  const cloud = (import.meta.env.VITE_CONVEX_URL as string | undefined) ?? "";
  return cloud.replace(/\.convex\.cloud\/?$/, ".convex.site");
}

/**
 * How pension money moves — switchable by the super admin, no code changes:
 *  • Direct: Penroute collects through its own Paystack account.
 *  • Approved provider: a PenCom-approved PSSP collects and remits.
 */
export function PaymentRouteSettings() {
  const data = useQuery(api.remittancePartner.getRouteSettings);
  const setRoute = useMutation(api.remittancePartner.setPaymentRoute);
  const savePartner = useMutation(api.remittancePartner.savePartner);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"portal" | "api">("portal");
  const [portalUrl, setPortalUrl] = useState("");
  const [apiEndpoint, setApiEndpoint] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [agreementRef, setAgreementRef] = useState("");

  if (!data) return null;
  const active = data.partners.find((p) => p.active) ?? null;
  const webhookUrl = `${siteUrl()}${data.webhookPath}`;

  const startEdit = () => {
    const p = active ?? data.partners[0];
    setCode(p?.code ?? "");
    setMode((p?.mode as "portal" | "api") ?? "portal");
    setPortalUrl(p?.portalUrl ?? "");
    setApiEndpoint(p?.apiEndpoint ?? "");
    setAgreementRef(p?.agreementRef ?? "");
    setApiSecret("");
    setWebhookSecret("");
    setEditing(true);
  };

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      return true;
    } catch (e) {
      toast.error(friendlyError(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pen-card-lg p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 font-bold tracking-tight">
            <ArrowLeftRight className="size-5 text-primary" /> How pension payments move
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Switch between collecting directly through Penroute's Paystack account and routing
            remittances through a PenCom-approved provider. Only the super admin can switch; every
            change is in the audit trail.
          </p>
        </div>
        <Badge variant="secondary" className={data.route === "partner" ? "bg-[#E6F6EF] text-[#04593A]" : ""}>
          Now: {data.route === "partner" ? `Approved provider${active ? ` · ${active.name}` : ""}` : "Direct (Paystack)"}
        </Badge>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {(["direct", "partner"] as const).map((r) => (
          <div key={r} className={`rounded-xl border p-4 ${data.route === r ? "border-[#007A4D] bg-[#F3FBF7]" : "border-[#E5E9EC]"}`}>
            <p className="font-semibold">{r === "direct" ? "Direct — Penroute collects (Paystack)" : "Approved provider (PenCom PSSP)"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {r === "direct"
                ? "Use only with Penroute's own CBN and PenCom approval, or for testing. Card and transfer charges below apply."
                : "The provider collects and remits; Penroute prepares and checks the schedule, tracks confirmation and invoices its service fee separately."}
            </p>
            {data.route === r ? (
              <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-[#04593A]">
                <CheckCircle2 className="size-4" /> In use
              </p>
            ) : data.canChange ? (
              <Button
                size="sm"
                className="mt-3"
                disabled={busy || (r === "partner" && !active)}
                title={r === "partner" && !active ? "Set up a provider below first" : undefined}
                onClick={() => {
                  if (window.confirm(`Switch pension payments to ${r === "partner" ? "the approved provider" : "direct Paystack collection"}?`)) {
                    void run(() => setRoute({ route: r }), "Payment route switched");
                  }
                }}
              >
                Switch to this
              </Button>
            ) : null}
          </div>
        ))}
      </div>

      <div className="mt-5 rounded-xl border border-[#E5E9EC] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 font-semibold">
            <Landmark className="size-4 text-primary" /> Approved provider
          </p>
          {data.canChange && !editing && (
            <Button size="sm" variant="outline" onClick={startEdit}>
              {active ? "Change provider details" : "Set up provider"}
            </Button>
          )}
        </div>
        {!editing ? (
          active ? (
            <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <dt className="text-muted-foreground">Provider</dt>
              <dd className="font-medium">{active.name}</dd>
              <dt className="text-muted-foreground">How employers pay</dt>
              <dd>{active.mode === "api" ? "Penroute sends the schedule to the provider's API" : "On the provider's platform with Penroute's schedule"}</dd>
              {active.portalUrl && (
                <>
                  <dt className="text-muted-foreground">Provider link</dt>
                  <dd className="truncate">{active.portalUrl}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Agreement reference</dt>
              <dd>{active.agreementRef ?? "—"}</dd>
              <dt className="text-muted-foreground">Automatic confirmations</dt>
              <dd>{active.hasWebhookSecret ? "On (signed webhook)" : "Off — confirm manually below"}</dd>
            </dl>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">No provider set up yet.</p>
          )
        ) : (
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap gap-3">
              <div className="w-60">
                <Label htmlFor="pp-code">Provider</Label>
                <select
                  id="pp-code"
                  className="mt-1.5 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                >
                  <option value="">Choose…</option>
                  {data.providers.map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="w-60">
                <Label htmlFor="pp-mode">How employers pay</Label>
                <select
                  id="pp-mode"
                  className="mt-1.5 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as "portal" | "api")}
                >
                  <option value="portal">On the provider's platform (works with any provider)</option>
                  <option value="api">Through the provider's API</option>
                </select>
              </div>
              <div className="w-60">
                <Label htmlFor="pp-agr">Agreement reference</Label>
                <Input id="pp-agr" className="mt-1.5" value={agreementRef} onChange={(e) => setAgreementRef(e.target.value)} placeholder="e.g. REMITA/PEN/2026/014" />
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <div className="w-80">
                <Label htmlFor="pp-portal">Provider link for employers (https)</Label>
                <Input id="pp-portal" className="mt-1.5" value={portalUrl} onChange={(e) => setPortalUrl(e.target.value)} placeholder="https://…" />
              </div>
              {mode === "api" && (
                <div className="w-80">
                  <Label htmlFor="pp-api">Provider API address (https)</Label>
                  <Input id="pp-api" className="mt-1.5" value={apiEndpoint} onChange={(e) => setApiEndpoint(e.target.value)} placeholder="https://…" />
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-3">
              {mode === "api" && (
                <div className="w-80">
                  <Label htmlFor="pp-secret">API key from the provider</Label>
                  <Input id="pp-secret" type="password" className="mt-1.5" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} placeholder={active?.hasApiSecret ? "Saved — leave blank to keep" : ""} />
                </div>
              )}
              <div className="w-80">
                <Label htmlFor="pp-wh">Webhook secret (shared with the provider)</Label>
                <Input id="pp-wh" type="password" className="mt-1.5" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder={active?.hasWebhookSecret ? "Saved — leave blank to keep" : "Optional — enables automatic confirmation"} />
              </div>
            </div>
            <div className="rounded-lg bg-[#F5F7F8] p-3 text-xs text-[#2A3B44]">
              Give the provider this confirmation address:{" "}
              <code className="break-all font-mono">{webhookUrl}</code>{" "}
              <button
                type="button"
                className="ml-1 inline-flex items-center gap-1 text-[#007A4D]"
                onClick={() => {
                  void navigator.clipboard?.writeText(webhookUrl);
                  toast.success("Copied");
                }}
              >
                <Copy className="size-3" /> Copy
              </button>
              <br />
              They sign each call with the webhook secret (header X-Penroute-Signature: sha256=…) and
              send paymentRef, status (paid or failed), amountKobo and their reference.
            </div>
            <div className="flex gap-2">
              <Button
                disabled={busy || !code}
                onClick={async () => {
                  const ok = await run(
                    () =>
                      savePartner({
                        code,
                        mode,
                        portalUrl,
                        apiEndpoint: mode === "api" ? apiEndpoint : undefined,
                        apiSecret: apiSecret ? apiSecret : undefined,
                        webhookSecret: webhookSecret ? webhookSecret : undefined,
                        agreementRef,
                        makeActive: true,
                      }),
                    "Provider saved and set as active",
                  );
                  if (ok) setEditing(false);
                }}
              >
                Save provider
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** Remittances made through the provider, waiting for confirmation. */
export function PartnerConfirmations() {
  const rows = useQuery(api.remittancePartner.listAwaitingConfirmation);
  const confirm = useMutation(api.remittancePartner.confirmPartnerPayment);
  const reject = useMutation(api.remittancePartner.rejectPartnerPayment);
  const [busy, setBusy] = useState<string | null>(null);
  if (!rows || rows.length === 0) return null;

  const act = async (id: Id<"payments">, fn: () => Promise<unknown>, ok: string) => {
    setBusy(id);
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="pen-card-lg p-6">
      <h2 className="font-bold tracking-tight">Provider remittances awaiting confirmation</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Check each one in the provider's records before confirming. The amount must match exactly.
        Signed confirmations from the provider clear these automatically.
      </p>
      <ul className="mt-4 divide-y rounded-lg border">
        {rows.map((r) => (
          <li key={r.paymentId} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {r.employerName} · {r.batchRef} · {fmtNaira(r.amountKobo)}
              </p>
              <p className="text-xs text-muted-foreground">
                {r.partnerName} · Penroute ref {r.paymentRef} ·{" "}
                {r.partnerRef ? `provider ref ${r.partnerRef} (reported ${fmtDateTime(r.declaredAt ?? undefined)})` : "employer has not reported paying yet"}
              </p>
            </div>
            <Button
              size="sm"
              disabled={busy === r.paymentId}
              onClick={() => {
                const ref = window.prompt(`${r.partnerName} reference you checked:`, r.partnerRef ?? "");
                if (!ref?.trim()) return;
                const amt = window.prompt(`Amount ${r.partnerName} shows received (₦):`, (r.amountKobo / 100).toFixed(2));
                if (!amt) return;
                const kobo = Math.round(Number(amt.replace(/[₦,\s]/g, "")) * 100);
                void act(r.paymentId, () => confirm({ paymentId: r.paymentId, partnerRef: ref, confirmedAmountKobo: kobo }), "Remittance confirmed");
              }}
            >
              Confirm
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy === r.paymentId}
              onClick={() => {
                const reason = window.prompt("Why can't this be confirmed?");
                if (reason?.trim()) void act(r.paymentId, () => reject({ paymentId: r.paymentId, reason }), "Marked not received");
              }}
            >
              Not received
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
