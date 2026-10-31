import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { friendlyError } from "@/lib/errors";
import { fmtDateTime } from "@/lib/pension";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

/**
 * Maker-checker queue for pricing and fee changes. Proposals take effect only
 * when a DIFFERENT admin with fee-approval authority approves them.
 */
export function PricingApprovals() {
  const data = useQuery(api.approvals.listPricingRequests);
  const approve = useMutation(api.approvals.approvePricingChange);
  const reject = useMutation(api.approvals.rejectPricingChange);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (id: Id<"pricingChangeRequests">, fn: () => Promise<unknown>, ok: string) => {
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

  if (!data) return null;
  return (
    <section className="pen-card-lg p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 font-bold tracking-tight">
            <ShieldCheck className="size-5 text-primary" /> Pricing changes awaiting approval
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The super admin changes prices directly. A change by any other administrator applies only
            after the super admin, or an approver they assigned, approves it.
          </p>
        </div>
        <Badge variant="secondary">
          {data.isSuperAdmin ? "Super admin" : data.isApprover ? "You can approve others' changes" : "You can propose changes"}
        </Badge>
      </div>

      {data.pending.length === 0 ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-[#007A4D]" /> No pricing changes are waiting.
        </p>
      ) : (
        <ul className="mt-4 divide-y rounded-lg border">
          {data.pending.map((r) => (
            <li key={r._id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{r.summary}</p>
                <p className="text-xs text-muted-foreground">
                  Proposed by {r.mine ? "you" : r.proposedByEmail} · {fmtDateTime(r.createdAt)}
                </p>
              </div>
              {r.canApprove && (
                <>
                  <Button
                    size="sm"
                    disabled={busy === r._id}
                    onClick={() => act(r._id, () => approve({ requestId: r._id }), "Approved — the new price is now in effect")}
                  >
                    {busy === r._id ? <Loader2 className="size-4 animate-spin" /> : "Approve"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === r._id}
                    onClick={() => {
                      const note = window.prompt("Reason for rejecting this change:");
                      if (note?.trim()) void act(r._id, () => reject({ requestId: r._id, note }), "Change rejected");
                    }}
                  >
                    Reject
                  </Button>
                </>
              )}
              {r.mine && (
                <>
                  <span className="text-xs font-medium text-[#7A5A10]">Awaiting another approver</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === r._id}
                    onClick={() => act(r._id, () => reject({ requestId: r._id, note: "" }), "Proposal withdrawn")}
                  >
                    Withdraw
                  </Button>
                </>
              )}
              {!r.mine && !r.canApprove && (
                <span className="text-xs text-muted-foreground">Needs an administrator with fee-approval authority</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {data.recent.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-semibold text-[#007A4D]">Recent decisions</summary>
          <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
            {data.recent.map((r) => (
              <li key={r._id}>
                <span className="font-semibold capitalize text-foreground">{r.status}</span> · {r.summary} · proposed by{" "}
                {r.proposedByEmail}
                {r.decidedByEmail && r.status !== "cancelled" ? `, ${r.status} by ${r.decidedByEmail}` : ""}
                {r.decisionNote ? ` — “${r.decisionNote}”` : ""} · {r.decidedAt ? fmtDateTime(r.decidedAt) : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** Administrator team & approval authority (managed by approvers only). */
export function AdminTeam() {
  const data = useQuery(api.approvals.listAdmins);
  const setAccess = useMutation(api.approvals.setAdminAccess);
  const claim = useMutation(api.approvals.claimApproverAuthority);
  const [email, setEmail] = useState("");
  const [approver, setApprover] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!data) return null;

  const save = async (e: string, admin: boolean, pricingApprover: boolean, ok: string) => {
    setBusy(true);
    try {
      await setAccess({ email: e, admin, pricingApprover });
      toast.success(ok);
      setEmail("");
      setApprover(false);
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pen-card-lg p-6">
      <h2 className="flex items-center gap-2 font-bold tracking-tight">
        <ShieldCheck className="size-5 text-primary" /> Administrators
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Only the <strong>super admin</strong> adds or removes administrators and decides who may
        <strong> approve fees</strong>. Other administrators can propose pricing changes, which wait for approval.
      </p>
      <ul className="mt-4 divide-y rounded-lg border">
        {data.admins.map((a) => (
          <li key={a._id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
            <span className="min-w-0 flex-1 truncate font-medium">
              {a.email}
              {a.isMe && <span className="text-muted-foreground"> (you)</span>}
            </span>
            <Badge variant="secondary" className={a.pricingApprover ? "bg-[#E6F6EF] text-[#04593A]" : ""}>
              {a.superAdmin ? "Super admin" : a.pricingApprover ? "Can approve fees" : "Can propose"}
            </Badge>
            {data.canManage && !a.isMe && !a.superAdmin && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    save(a.email, true, !a.pricingApprover, a.pricingApprover ? "Approval authority removed" : "Approval authority granted")
                  }
                >
                  {a.pricingApprover ? "Remove approval authority" : "Grant approval authority"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Remove administrator access for ${a.email}?`)) void save(a.email, false, false, "Administrator removed");
                  }}
                >
                  Remove
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {data.canClaimApprover && (
        <div className="mt-4 rounded-lg border border-[#D4AF37]/40 bg-[#FBF3E0] p-3 text-sm text-[#7A5A10]">
          This platform has no super admin yet. As the founding operator you can take that role once.
          <Button
            size="sm"
            className="ml-3"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await claim({});
                toast.success("You are now the super admin");
              } catch (err) {
                toast.error(friendlyError(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Become super admin
          </Button>
        </div>
      )}
      {data.canManage ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            type="email"
            aria-label="New administrator email"
            className="h-9 w-64 rounded-md border border-input bg-background px-3 text-sm"
            placeholder="colleague@penroute.net"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[#007A4D]" checked={approver} onChange={(e) => setApprover(e.target.checked)} />
            Can approve fees
          </label>
          <Button size="sm" disabled={busy || !email.includes("@")} onClick={() => save(email, true, approver, "Administrator added")}>
            Add administrator
          </Button>
          <p className="w-full text-xs text-muted-foreground">They must sign in to penroute.net once before you add them.</p>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">Only the super admin can change this list.</p>
      )}
    </section>
  );
}
