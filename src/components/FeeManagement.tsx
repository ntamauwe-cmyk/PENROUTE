import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { friendlyError } from "@/lib/errors";
import { fmtNaira } from "@/lib/pension";
import { toast } from "sonner";

/**
 * Per-employee processing fee. Read-only with "Change fee"; the super admin
 * saves directly, any other admin submits for approval (maker-checker).
 */
export function FeeManagement() {
  const overview = useQuery(api.admin.getAdminOverview);
  const requests = useQuery(api.approvals.listPricingRequests);
  const updateFee = useMutation(api.admin.adminUpdateFee);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const currentKobo = overview?.effectiveFeePerEmployeeKobo ?? overview?.feePerEmployeeKobo;
  const pending = requests?.pending.find((r) => r.kind === "flatFee");
  const isSuper = Boolean(requests?.isSuperAdmin);

  const save = async () => {
    const naira = Number(value.replace(/[₦,\s]/g, ""));
    if (!value.trim() || !Number.isFinite(naira) || naira < 0 || naira > 100_000) {
      toast.error("Enter the fee in naira, e.g. 9 or 9.50");
      return;
    }
    const kobo = Math.round(naira * 100);
    setBusy(true);
    try {
      const res = await updateFee({ perEmployeeFeeKobo: kobo });
      const amount = fmtNaira(kobo);
      if ("pending" in res) {
        toast.success("Fee change submitted for approval", {
          description: `${amount} per employee takes effect once the super admin or an assigned approver approves it.`,
        });
      } else {
        toast.success(`Fee updated to ${amount} per employee — applied to every active pricing tier`);
      }
      setEditing(false);
    } catch (e) {
      toast.error(friendlyError(e, "Update failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pen-card-lg p-6">
      <h2 className="font-bold tracking-tight">Fee management</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Penroute processing fee per employee, per monthly contribution. It applies to every active
        pricing tier, quotes, employer billing and the public pricing page. Only the super admin
        changes it directly; any other administrator's change waits for approval.
      </p>
      {!editing ? (
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Current fee per employee
            </p>
            <p className="text-2xl font-bold tabular-nums">
              {currentKobo === undefined ? "—" : fmtNaira(currentKobo)}
            </p>
          </div>
          <Button
            variant="outline"
            className="font-semibold"
            disabled={Boolean(pending) || currentKobo === undefined}
            onClick={() => {
              setValue(currentKobo === undefined ? "" : String(currentKobo / 100));
              setEditing(true);
            }}
          >
            Change fee
          </Button>
          {pending && <p className="text-sm text-[#7A5A10]">Awaiting approval: {pending.summary}</p>}
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="w-40">
            <Label htmlFor="fee-naira">New fee per employee (₦)</Label>
            <div className="relative mt-1.5">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                ₦
              </span>
              <Input
                id="fee-naira"
                className="pl-7"
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void save()}
                inputMode="decimal"
                placeholder="9.00"
              />
            </div>
          </div>
          <Button className="font-semibold" onClick={() => void save()} disabled={busy}>
            {isSuper ? "Save new fee" : "Submit for approval"}
          </Button>
          <Button variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      )}
    </section>
  );
}
