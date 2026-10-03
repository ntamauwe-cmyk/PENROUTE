import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { DashboardShell } from "@/components/DashboardShell";
import { LoadingBlock, PageHeader, useEmployer } from "@/components/pension-ui";
import { fmtDateTime, fmtNaira } from "@/lib/pension";
import {
  Building2,
  CheckCircle2,
  Code2,
  Github,
  Landmark,
  Loader2,
  Mail,
  MapPin,
  Phone,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  User,
} from "lucide-react";
import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";

import { toast } from "sonner";

export default function Settings() {
  const { employer, loading } = useEmployer();
  const pricing = useQuery(api.pricing.getPublicPricing);
  const keyStatus = useQuery(api.employers.getApiKeysStatus);

  if (loading) {
    return (
      <DashboardShell>
        <LoadingBlock label="Loading settings…" />
      </DashboardShell>
    );
  }

  return (
    <DashboardShell>
      <PageHeader
        title="Settings"
        description="Your employer profile, pricing and platform integration status."
      />

      {!employer ? (
        <div className="pen-card p-8 text-center text-sm text-muted-foreground">
          No employer profile yet — load the demo workspace from the Dashboard.
        </div>
      ) : (
        <section className="pen-card-lg p-6">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10">
              <Building2 className="size-5 text-primary" />
            </div>
            <div>
              <h2 className="font-bold tracking-tight">{employer.name}</h2>
              <p className="text-xs text-muted-foreground">
                Employer profile · verified against KYC requirements
              </p>
            </div>
            <Badge
              className={`ml-auto ${
                employer.kycStatus === "verified"
                  ? "bg-[#E6F6EF] text-[#04593A]"
                  : "bg-[#FBF3E0] text-[#7A5A10]"
              }`}
            >
              <ShieldCheck className="size-3" /> KYC {employer.kycStatus}
            </Badge>
          </div>

          <Separator className="my-5" />

          <div className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
            {(
              [
                ["Registration (RC)", employer.rcNumber, Building2],
                ["TIN", employer.tin, Building2],
                ["Representative", employer.representativeName, User],
                ["Contact email", employer.contactEmail, Mail],
                ["Contact phone", employer.contactPhone, Phone],
                ["Registered address", employer.registeredAddress, MapPin],
              ] as const
            ).map(([label, value, Icon]) => (
              <div key={label} className="flex items-start gap-2.5">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {label}
                  </p>
                  <p className="mt-0.5 font-medium">{value}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Payroll/HR API integration (spec §4) */}
      <PayrollIntegrationCard keyStatus={keyStatus ?? null} hasEmployer={Boolean(employer)} />

      {/* GitHub source sync */}
      <GitHubSyncCard />

      {/* Pricing */}
      <section className="pen-card-lg p-6">
        <h2 className="font-bold tracking-tight">Platform pricing</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Processing-fee tiers configured centrally by platform administrators —
          never hard-coded. Your applicable rate is set by your employee posting
          volume.
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {(pricing?.tiers ?? []).map((t) => (
            <div key={t.code} className="pen-card flex items-center justify-between p-4">
              <div>
                <p className="text-sm font-semibold">{t.label}</p>
                <p className="text-xs text-muted-foreground">Per employee posting</p>
              </div>
              <p className="text-xl font-bold tabular-nums">
                {pricing === undefined ? "—" : fmtNaira(t.feePerPostingKobo)}
              </p>
            </div>
          ))}
          {pricing === undefined && (
            <div className="pen-card flex items-center justify-center p-4 text-sm text-muted-foreground">
              Loading pricing…
            </div>
          )}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Penroute processing fees are technology/service charges — separate from
          your employees' pension contributions.
        </p>
      </section>

      {/* Integration status */}
      <section className="pen-card-lg p-6">
        <div className="flex items-center gap-2">
          <Landmark className="size-5 text-primary" />
          <h2 className="font-bold tracking-tight">Integrations</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Sandbox adapters implement the exact contract live PENCOM / PFA / settlement
          integrations will use — replacing them is a configuration change, not a rewrite.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {[
            ["PENCOM validation", "pencom_sandbox", "Pension PIN validation + schedule checks"],
            ["PFA connectivity", "pfa_sandbox", "Contribution files + acknowledgements"],
            ["Settlement rail", "settlement_sandbox", "Collection + per-PFA settlement instructions"],
          ].map(([title, adapter, desc]) => (
            <div key={adapter} className="pen-card p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold">{title}</p>
                <Badge variant="secondary">sandbox</Badge>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">{desc}</p>
              <p className="mt-2 font-mono text-[10px] text-muted-foreground">{adapter}</p>
            </div>
          ))}
        </div>
      </section>
    </DashboardShell>
  );
}

/**
 * GitHub source sync — commits the complete Penroute project source to the
 * existing GitHub repository in ONE commit (nothing is deleted; the commit is
 * built on top of the repo's current head). Requires GITHUB_TOKEN in the
 * platform Keys tab.
 */
function GitHubSyncCard() {
  const [pushId] = useState(() => `push-${Date.now().toString(36)}`);
  const [owner, setOwner] = useState("ntamauwe-cmyk");
  const [repo, setRepo] = useState("penroute");
  const [verifying, setVerifying] = useState(false);
  const [staging, setStaging] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [verifyResult, setVerifyResult] = useState<
    { ok: boolean; fullName?: string; isPrivate?: boolean; defaultBranch?: string; reason?: string } | null
  >(null);
  const [pushResult, setPushResult] = useState<
    | { ok: true; commitSha: string; commitUrl: string; branch: string; filesCommitted: number; filesUnchanged: number; filesFailed: number }
    | { ok: false; error: string; failures?: { path: string; error: string }[] }
    | null
  >(null);

  const verify = useAction(api.githubSync.verifyRepo);
  const stage = useMutation(api.githubSyncData.stagePush);
  const push = useAction(api.githubSync.pushToGitHub);
  const status = useQuery(api.githubSyncData.githubPushStatus, { pushId });

  const handleVerify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await verify({ owner, repo });
      setVerifyResult(res);
    } catch (e) {
      setVerifyResult({ ok: false, reason: e instanceof Error ? e.message : "Verification failed" });
    } finally {
      setVerifying(false);
    }
  };

  const handlePush = async () => {
    setStaging(true);
    setPushResult(null);
    try {
      const staged = await stage({ pushId });
      toast.info(`Staging ${staged.staged} files (${(staged.totalBytes / 1024).toFixed(0)} KB)…`);
      setStaging(false);
      setPushing(true);
      const res = await push({ owner, repo, pushId });
      if (res.ok) {
        setPushResult({
          ok: true,
          commitSha: res.commitSha,
          commitUrl: res.commitUrl,
          branch: res.branch,
          filesCommitted: res.filesCommitted,
          filesUnchanged: res.filesUnchanged,
          filesFailed: res.filesFailed,
        });
        toast.success(
          `Committed to ${res.branch} — ${res.filesCommitted + res.filesUnchanged} files (${res.commitSha.slice(0, 7)})`,
        );
      } else {
        setPushResult({ ok: false, error: res.error, failures: res.failures });
        toast.error(res.error);
      }
    } catch (e) {
      setPushResult({ ok: false, error: e instanceof Error ? e.message : "Push failed" });
      toast.error("Push failed");
    } finally {
      setStaging(false);
      setPushing(false);
    }
  };

  const busy = verifying || staging || pushing;
  const stagedCount = status?.byStatus?.staged ?? 0;

  return (
    <section className="pen-card-lg p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Github className="size-5 text-primary" />
          <h2 className="font-bold tracking-tight">GitHub repository sync</h2>
        </div>
        {pushResult?.ok && (
          <Badge className="bg-[#E6F6EF] text-[#04593A]">
            <CheckCircle2 className="size-3" /> Pushed to {pushResult.branch}
          </Badge>
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Commits the complete Penroute source (all pages, backend, schema, branding) to your
        existing repository in a single commit — existing repository files are preserved, nothing
        is deleted. Secrets, .env files, dependencies and generated code are excluded.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <div>
          <Label>Owner</Label>
          <Input className="mt-1.5" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="ntamauwe-cmyk" />
        </div>
        <div>
          <Label>Repository</Label>
          <Input className="mt-1.5" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="penroute" />
        </div>
        <div className="flex items-end gap-2">
          <Button variant="outline" onClick={handleVerify} disabled={busy || !owner || !repo}>
            {verifying ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            Verify
          </Button>
          <Button className="bg-[#007A4D] font-semibold hover:bg-[#006A43]" onClick={handlePush} disabled={busy || !owner || !repo}>
            {staging || pushing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Commit & push
          </Button>
        </div>
      </div>

      {verifyResult && (
        <p
          className={`mt-3 text-xs font-medium ${
            verifyResult.ok ? "text-[#04593A]" : "text-[#C4453C]"
          }`}
        >
          {verifyResult.ok
            ? `✓ Connected to ${verifyResult.fullName}${verifyResult.isPrivate ? " (private)" : ""} · default branch ${verifyResult.defaultBranch}`
            : `✕ ${verifyResult.reason}`}
        </p>
      )}

      {status && status.total > 0 && !pushResult?.ok && (
        <p className="mt-2 text-xs text-muted-foreground">
          Last staging: {status.total} files ·{" "}
          {Object.entries(status.byStatus)
            .map(([k, v]) => `${v} ${k}`)
            .join(" · ")}
        </p>
      )}

      {pushResult && (
        <div className="pen-inset mt-4 p-4">
          {pushResult.ok ? (
            <>
              <p className="text-sm font-bold text-[#0B1F2A]">
                Committed “Initial Penroute application commit” to {pushResult.branch}
              </p>
              <p className="mt-1 text-xs text-[#5A6B74]">
                Commit {pushResult.commitSha.slice(0, 10)} · {pushResult.filesCommitted} files uploaded ·{" "}
                {pushResult.filesUnchanged} unchanged · {pushResult.filesFailed} failed
              </p>
              <a
                href={pushResult.commitUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block text-xs font-bold text-[#007A4D] hover:underline"
              >
                View commit on GitHub →
              </a>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-[#8A2F28]">{pushResult.error}</p>
              {pushResult.failures && pushResult.failures.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {pushResult.failures.map((f) => (
                    <li key={f.path} className="truncate">
                      <span className="font-mono">{f.path}</span> — {f.error}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        Uses the GITHUB_TOKEN from the platform Keys tab (classic personal access token with the
        repo scope). The token is only read server-side and is never exposed to the browser or
        included in any commit.
      </p>
    </section>
  );
}

/**
 * Payroll/HR integration (spec §4) — generate/rotate/revoke the employer API
 * key and push the monthly schedule straight from your payroll system.
 * The key is shown exactly once (like Stripe/GitHub tokens) and lives only on
 * the server; the browser never reads it back.
 */
function PayrollIntegrationCard({
  keyStatus,
  hasEmployer,
}: {
  keyStatus: { hasKey: boolean; createdAt: number | null } | null;
  hasEmployer: boolean;
}) {
  const generateKey = useMutation(api.employers.generateApiKey);
  const revokeKey = useMutation(api.employers.revokeApiKey);
  const [showKey, setShowKey] = useState(false);
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<"generate" | "revoke" | null>(null);

  const handleGenerate = async () => {
    setBusy("generate");
    try {
      const res = await generateKey({});
      setGeneratedKey(res.apiKey);
      setShowKey(true);
      toast.success("API key generated — copy it now, it won't be shown again");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not generate key");
    } finally {
      setBusy(null);
    }
  };

  const handleRevoke = async () => {
    setBusy("revoke");
    try {
      await revokeKey({});
      setShowKey(false);
      setGeneratedKey(null);
      toast.success("API key revoked");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not revoke key");
    } finally {
      setBusy(null);
    }
  };

  const curlSample = `curl -X POST ${window.location.origin}/api/v1/schedules \\
  -H "Authorization: Bearer penr_live_xxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{
    "contributionYear": ${new Date().getFullYear()},
    "contributionMonth": ${new Date().getMonth() + 1},
    "records": [
      {
        "fullName": "Adaeze Okafor",
        "employeeCode": "EMP-001",
        "pensionPin": "PIN100000",
        "pfaCode": "001",
        "employeeContribution": 25000,
        "employerContribution": 25000
      }
    ]
  }'`;

  return (
    <section className="pen-card-lg p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <PlugZap className="size-5 text-primary" />
          <h2 className="font-bold tracking-tight">Payroll / HR integration</h2>
        </div>
        {keyStatus?.hasKey ? (
          <Badge className="bg-[#E6F6EF] text-[#04593A]">
            <CheckCircle2 className="size-3" /> Connected
          </Badge>
        ) : (
          <Badge variant="secondary">Not connected</Badge>
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect your payroll or HR system and push the monthly pension schedule straight into
        Penroute — no manual uploads. The schedule lands as an awaiting-payment batch you review
        and authorise as usual.
      </p>

      {!hasEmployer ? (
        <p className="pen-inset mt-4 p-4 text-sm text-muted-foreground">
          Create your employer workspace first — then generate an API key here.
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              className="bg-[#007A4D] font-semibold hover:bg-[#006A43]"
              onClick={handleGenerate}
              disabled={busy !== null}
            >
              {busy === "generate" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Code2 className="size-4" />
              )}
              {keyStatus?.hasKey ? "Rotate key" : "Generate API key"}
            </Button>
            {keyStatus?.hasKey && (
              <>
                <span className="text-xs text-muted-foreground">
                  Active since {keyStatus.createdAt ? fmtDateTime(keyStatus.createdAt) : "—"}
                </span>
                <Button variant="outline" onClick={handleRevoke} disabled={busy !== null}>
                  {busy === "revoke" ? <Loader2 className="size-4 animate-spin" /> : null}
                  Revoke
                </Button>
              </>
            )}
          </div>

          {showKey && generatedKey && (
            <div className="pen-inset mt-4 p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-[#0B1F2A]">
                Your new API key — copy it now
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-white px-3 py-2 font-mono text-xs">
                  {generatedKey}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard.writeText(generatedKey);
                    toast.success("API key copied to clipboard");
                  }}
                >
                  Copy
                </Button>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                This is the only time the key is displayed. Store it in your payroll system's
                secret manager.
              </p>
            </div>
          )}

          <div className="pen-inset mt-4 p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-[#0B1F2A]">
              Endpoint
            </p>
            <code className="mt-2 block overflow-x-auto whitespace-pre rounded-md border border-border bg-white px-3 py-2.5 font-mono text-[11px] leading-relaxed text-[#33454F]">
              {curlSample}
            </code>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Amounts are in naira. Duplicate submissions are idempotent — your payroll system can
              safely retry. The batch then appears under Pension Payments → awaiting payment.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
