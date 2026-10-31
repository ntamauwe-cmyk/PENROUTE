import { useState } from "react";
import { useMutation } from "convex/react";
import { Link } from "react-router";
import { api } from "@/convex/_generated/api";
import { friendlyError } from "@/lib/errors";
import { Logo } from "@/components/Brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmtNaira, monthName } from "@/lib/pension";
import { CheckCircle2, Clock, Loader2, Search, TriangleAlert } from "lucide-react";

type Response = Awaited<ReturnType<ReturnType<typeof useMutation<typeof api.employeeCheck.checkMyContributions>>>>;
type Result = Extract<Response, { ok: true }>;

const STATUS = {
  posted: { label: "Posted to your RSA", cls: "bg-[#E6F6EF] text-[#04593A]", icon: CheckCircle2 },
  paid_awaiting_pfa: { label: "Paid — awaiting PFA posting", cls: "bg-[#FBF3E0] text-[#7A5A10]", icon: Clock },
  not_paid: { label: "Not yet paid by employer", cls: "bg-[#EEF2F4] text-[#5A6B74]", icon: Clock },
  payment_failed: { label: "Employer payment failed", cls: "bg-[#FBEAE8] text-[#8A2F28]", icon: TriangleAlert },
} as const;

/** Public page: an employee checks their own pension contributions. */
export default function CheckContributions() {
  const check = useMutation(api.employeeCheck.checkMyContributions);
  const [form, setForm] = useState({ pensionPin: "", employeeCode: "", surname: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await check(form);
      if (res.ok) setResult(res);
      else setError(res.error);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F7F9F8]">
      <header className="border-b border-[#E5E9EC] bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Link to="/" aria-label="Penroute home">
            <Logo size="sm" />
          </Link>
          <Link to="/auth" className="text-sm font-semibold text-[#007A4D] hover:underline">
            Employer sign in
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-10 sm:px-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#0B1F2A] sm:text-3xl">Check my pension contributions</h1>
          <p className="mt-2 text-[15px] text-[#5A6B74]">
            If your employer pays pensions through Penroute, see each month's contribution and whether your
            PFA has posted it to your Retirement Savings Account.
          </p>
        </div>

        <form onSubmit={submit} className="pen-card-lg grid gap-4 p-6 sm:grid-cols-3">
          <div>
            <Label htmlFor="pin">RSA PIN</Label>
            <Input id="pin" className="mt-1.5" autoComplete="off" required placeholder="PEN100123456789"
              value={form.pensionPin} onChange={(e) => setForm((f) => ({ ...f, pensionPin: e.target.value }))} />
          </div>
          <div>
            <Label htmlFor="code">Staff / employee ID</Label>
            <Input id="code" className="mt-1.5" autoComplete="off" required placeholder="As on your payslip"
              value={form.employeeCode} onChange={(e) => setForm((f) => ({ ...f, employeeCode: e.target.value }))} />
          </div>
          <div>
            <Label htmlFor="surname">Surname</Label>
            <Input id="surname" className="mt-1.5" autoComplete="family-name" required
              value={form.surname} onChange={(e) => setForm((f) => ({ ...f, surname: e.target.value }))} />
          </div>
          <div className="sm:col-span-3">
            <Button type="submit" disabled={busy} className="w-full bg-[#007A4D] font-semibold hover:bg-[#006A43] sm:w-auto">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />} Check contributions
            </Button>
            <p className="mt-2 text-xs text-[#5A6B74]">
              Your details are only used to find your own records. After 5 unsuccessful tries the PIN is locked for an hour.
            </p>
          </div>
        </form>

        {error && (
          <p role="alert" className="pen-card flex items-start gap-2 p-4 text-sm text-[#8A2F28]">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {error}
          </p>
        )}

        {result && (
          <section className="pen-card-lg p-6">
            <h2 className="font-bold tracking-tight text-[#0B1F2A]">Hello {result.firstName}</h2>
            <p className="mt-1 text-sm text-[#5A6B74]">
              {result.lines.length === 0
                ? "No contributions have been submitted for you through Penroute yet."
                : `${result.lines.length} month${result.lines.length === 1 ? "" : "s"} found${result.pfaName ? ` · current PFA: ${result.pfaName}` : ""}.`}
            </p>
            {result.lines.length > 0 && (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-[#5A6B74]">
                      <th className="px-3 py-2">Month</th>
                      <th className="px-3 py-2">Employer · PFA</th>
                      <th className="px-3 py-2 text-right">You</th>
                      <th className="px-3 py-2 text-right">Employer</th>
                      <th className="px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.lines.map((l) => {
                      const st = STATUS[l.status as keyof typeof STATUS];
                      const Icon = st.icon;
                      return (
                        <tr key={`${l.period}-${l.employerName}`} className="border-t border-[#EDF0F2]">
                          <td className="px-3 py-2.5 font-medium">{monthName(l.month)} {l.year}</td>
                          <td className="px-3 py-2.5 text-[#5A6B74]">{l.employerName}<br />{l.pfaName}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{fmtNaira(l.employeeKobo)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{fmtNaira(l.employerKobo)}</td>
                          <td className="px-3 py-2.5">
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${st.cls}`}>
                              <Icon className="size-3.5" /> {st.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-4 text-xs leading-relaxed text-[#5A6B74]">
              A month marked "posted" has been confirmed by your PFA. If a month is missing or stays unpaid past
              the deadline, speak to your HR team first; you can also report non-remittance to the National Pension
              Commission (PenCom).
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
