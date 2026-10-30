import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DashboardShell } from "@/components/DashboardShell";
import { PageHeader } from "@/components/pension-ui";
import { Building2, CheckCircle2 } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";

/**
 * Self-service employer onboarding (spec §4) — plug-and-play multi-tenancy.
 * Any signed-in user can register their company and get a private workspace
 * immediately (RC numbers are uniqueness-checked; audit trail is written).
 */
export default function Onboarding() {
  const register = useMutation(api.pension.registerEmployer);
  const seed = useMutation(api.pension.seedDemoData);
  const claim = useMutation(api.pension.claimDemoEmployer);
  const dash = useQuery(api.pension.getEmployerDashboard);
  const deployment = useQuery(api.pension.deploymentInfo);
  const { user } = useAuth();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [form, setForm] = useState({
    name: "",
    rcNumber: "",
    tin: "",
    registeredAddress: "",
    contactEmail: "",
    contactPhone: "",
    representativeName: "",
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accepted) {
      toast.error("Please accept the Terms of Service and Privacy Notice");
      return;
    }
    setSaving(true);
    try {
      await register({ ...form, acceptTerms: true });
      toast.success("Registration submitted", {
        description: `${form.name} is under review. Add your employees now — payments open once Penroute approves your account.`,
      });
      navigate("/dashboard");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setSaving(false);
    }
  };

  const loadDemo = async () => {
    setSaving(true);
    try {
      await seed({});
      // Always claim: seed returns `already_seeded` on pre-existing
      // deployments, and skipping the claim there left the user without a
      // workspace (the demo link never happened).
      await claim({});
      navigate("/dashboard");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load demo data");
    } finally {
      setSaving(false);
    }
  };

  const hasWorkspace = Boolean(dash?.employer);
  const inputCls = "mt-1.5";

  return (
    <DashboardShell>
      <PageHeader
        title="Employer onboarding"
        description="Register your company once — recurring monthly contributions take just a few clicks afterwards."
      />

      {hasWorkspace && (
        <div className="pen-card flex items-center gap-3 p-4 text-sm">
          <CheckCircle2 className="size-5 text-[#007A4D]" />
          <p>
            You're currently working in <strong>{dash?.employer?.name}</strong>. Registering a new
            company switches your account to that new workspace.
          </p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="pen-card-lg p-6">
        <div className="flex items-center gap-2">
          <Building2 className="size-5 text-primary" />
          <h2 className="font-bold tracking-tight">Company details</h2>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label>Registered company name</Label>
            <Input className={inputCls} value={form.name} onChange={set("name")} placeholder="Acme Nigeria Limited" required />
          </div>
          <div>
            <Label>RC / registration number</Label>
            <Input className={inputCls} value={form.rcNumber} onChange={set("rcNumber")} placeholder="RC-1234567" required />
          </div>
          <div>
            <Label>TIN</Label>
            <Input className={inputCls} value={form.tin} onChange={set("tin")} placeholder="TIN-12345678-0001" required />
          </div>
          <div className="sm:col-span-2">
            <Label>Registered address</Label>
            <Input className={inputCls} value={form.registeredAddress} onChange={set("registeredAddress")} placeholder="1 Marina Road, Lagos Island, Lagos" />
          </div>
          <div>
            <Label>Contact email</Label>
            <Input className={inputCls} type="email" value={form.contactEmail} onChange={set("contactEmail")} placeholder="pensions@company.ng" required />
          </div>
          <div>
            <Label>Contact phone</Label>
            <Input className={inputCls} value={form.contactPhone} onChange={set("contactPhone")} placeholder="+234 800 000 0000" />
          </div>
          <div>
            <Label>Authorized representative</Label>
            <Input className={inputCls} value={form.representativeName} onChange={set("representativeName")} placeholder="Full name" />
          </div>
        </div>

        <label className="mt-6 flex items-start gap-2 text-sm text-[#5A6B74]">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-[#007A4D]"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            required
          />
          <span>
            I am authorised to register this company and I accept the{" "}
            <Link to="/terms" target="_blank" className="font-semibold text-[#007A4D] hover:underline">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link to="/privacy" target="_blank" className="font-semibold text-[#007A4D] hover:underline">
              Privacy Notice
            </Link>
            .
          </span>
        </label>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="submit" className="font-semibold" disabled={saving || !accepted}>
            {saving ? "Creating workspace…" : "Create workspace"}
          </Button>
          {!hasWorkspace && deployment?.sandboxMode && user?.role === "admin" && (
            <Button type="button" variant="outline" onClick={loadDemo} disabled={saving}>
              Or load the demo workspace
            </Button>
          )}
        </div>
      </form>
    </DashboardShell>
  );
}
