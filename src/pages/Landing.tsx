import { motion } from "framer-motion";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Logo, RouteLines, PenrouteSymbol } from "@/components/Brand";
import {
  ArrowRight,
  Building2,
  FileText,
  Landmark,
  RefreshCcw,
  ShieldCheck,
  Users,
  Zap,
} from "lucide-react";
import { useNavigate } from "react-router";

const fade = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-60px" },
};

const TRUST = [
  { icon: ShieldCheck, title: "Secure", sub: "& Compliant" },
  { icon: Zap, title: "Fast", sub: "& Reliable" },
  { icon: Users, title: "For Employers,", sub: "Employees & PFAs" },
  { icon: Building2, title: "Built for a", sub: "Stronger Tomorrow" },
];

const STEPS = [
  { n: "01", title: "Add Employees", desc: "Load your workforce with pension PINs and PFA details." },
  { n: "02", title: "Prepare Contributions", desc: "Employee and employer amounts for the month." },
  { n: "03", title: "Review & Authorise", desc: "One clear summary before anything is paid." },
  { n: "04", title: "Process Payment", desc: "One consolidated payment for the whole organisation." },
  { n: "05", title: "Reconcile", desc: "Every PFA allocation verified before it's marked complete." },
];

export default function Landing() {
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();
  const enter = () => navigate(isAuthenticated ? "/dashboard" : "/auth");

  return (
    <div className="min-h-screen bg-white">
      {/* ================= Header ================= */}
      <header className="pen-nav sticky top-0 z-40">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6">
          <Logo onDark />
          <nav className="hidden items-center gap-7 text-[13px] font-medium text-white/70 lg:flex">
            <a href="#product" className="transition-colors hover:text-white">Product</a>
            <a href="#workflow" className="transition-colors hover:text-white">How It Works</a>
            <a href="#trust" className="transition-colors hover:text-white">Trust</a>
            <a href="#pricing" className="transition-colors hover:text-white">Pricing</a>
          </nav>
          <div className="flex items-center gap-3">
            <button
              className="hidden text-sm font-semibold text-white/85 transition-colors hover:text-white sm:block"
              onClick={enter}
            >
              Log In
            </button>
            <Button
              className="bg-[#00C896] font-semibold text-[#06251B] hover:bg-[#10d6a4]"
              disabled={isLoading}
              onClick={enter}
            >
              Get Started
            </Button>
          </div>
        </div>
      </header>

      {/* ================= Hero — dark navy treatment ================= */}
      <section className="pen-nav relative overflow-hidden">
        <RouteLines />
        <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-4 pb-20 pt-16 sm:px-6 lg:grid-cols-2 lg:pb-28 lg:pt-24">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <h1 className="text-4xl font-bold leading-[1.06] tracking-tight sm:text-5xl lg:text-6xl">
              Pension
              <br />
              Payments.
              <br />
              <span className="text-[#00C896]">Simplified.</span>
            </h1>
            <span className="pen-gold-rule mt-7" />
            <p className="mt-6 max-w-lg text-base leading-relaxed text-white/70 sm:text-lg">
              Penroute helps employers manage pension contributions and organises the workflow
              between employers, employees and Pension Fund Administrators — payroll to RSA,
              in one place.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-4">
              <Button
                size="lg"
                className="bg-[#00C896] px-7 font-semibold text-[#06251B] hover:bg-[#10d6a4]"
                onClick={enter}
              >
                Get Started <ArrowRight className="size-4" />
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="border-white/25 bg-transparent px-7 font-semibold text-white hover:bg-white/10 hover:text-white"
                onClick={enter}
              >
                See How It Works
              </Button>
            </div>
            <p className="mt-8 text-xs font-semibold uppercase tracking-[0.22em] text-white/45">
              Employers. Employees. Pension Funds. United.
            </p>
          </motion.div>

          {/* Dashboard preview card — mirrors the reference laptop screen */}
          <motion.div
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.7, delay: 0.15 }}
            className="relative"
          >
            <div className="rounded-2xl border border-white/10 bg-white p-5 shadow-[0_40px_120px_-30px_rgba(0,0,0,0.6)] sm:p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-[#0B1F2A]">Good morning, Employer</p>
                  <p className="text-xs text-[#5A6B74]">Here's your pension payment overview.</p>
                </div>
                <PenrouteSymbol className="size-7" />
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2.5">
                {[
                  ["Total Employees", "248", "text-[#0B1F2A]"],
                  ["Total Contributions", "₦4.86M", "text-[#007A4D]"],
                  ["Pending Payment", "₦720,000", "text-[#D4AF37]"],
                ].map(([k, v, c]) => (
                  <div key={k} className="rounded-lg border border-[#E5E9EC] bg-[#F8FAFA] p-3">
                    <p className="text-[10px] font-semibold text-[#5A6B74]">{k}</p>
                    <p className={`mt-1 text-base font-bold tabular-nums ${c}`}>{v}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 overflow-hidden rounded-lg border border-[#E5E9EC]">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-[#0B1F2A] text-left text-[10px] uppercase tracking-wide text-white/80">
                      <th className="px-3 py-2 font-semibold">Date</th>
                      <th className="px-3 py-2 font-semibold">Staff</th>
                      <th className="px-3 py-2 text-right font-semibold">Amount</th>
                      <th className="px-3 py-2 text-right font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ["12 Sep 2026", "48", "₦720,000"],
                      ["10 Sep 2026", "32", "₦480,000"],
                      ["05 Sep 2026", "56", "₦640,000"],
                    ].map(([d, s, a]) => (
                      <tr key={d} className="border-t border-[#EDF0F2]">
                        <td className="px-3 py-2 font-medium text-[#0B1F2A]">{d}</td>
                        <td className="px-3 py-2 tabular-nums text-[#5A6B74]">{s}</td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums text-[#0B1F2A]">{a}</td>
                        <td className="px-3 py-2 text-right">
                          <span className="pill st-green">
                            <span className="pill-dot" /> Completed
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex items-center justify-between rounded-lg bg-[#0B1F2A] p-3.5">
                <p className="text-xs font-medium text-white/80">
                  Your employees' future matters.
                </p>
                <span className="rounded-md bg-[#00C896] px-3 py-1.5 text-[11px] font-bold text-[#06251B]">
                  Make Payment
                </span>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ================= Brand story ================= */}
      <section id="product" className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:py-28">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <motion.div {...fade} transition={{ duration: 0.5 }}>
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#007A4D]">
              Brand Story
            </p>
            <h2 className="mt-3 text-3xl font-bold leading-tight tracking-tight text-[#0B1F2A] sm:text-4xl">
              Connecting Employers, Employees and Pension Funds — Seamlessly.
            </h2>
            <p className="mt-5 text-base leading-relaxed text-[#5A6B74]">
              Penroute is Nigeria's trusted pension payment platform, built to make employee
              pension contributions simple, fast and compliant. We help employers pay, employees
              secure their future, and Pension Fund Administrators receive contributions — all in
              one place.
            </p>
            <ul className="mt-7 space-y-3.5">
              {[
                "One consolidated payment for your entire organisation",
                "Automatic validation, allocation and routing to every PFA",
                "Reconciliation before anything is marked complete",
                "Audit-ready receipts for accounting and HR records",
              ].map((t) => (
                <li key={t} className="flex items-start gap-3 text-sm text-[#33454F]">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[#E6F6EF]">
                    <ShieldCheck className="size-3 text-[#007A4D]" />
                  </span>
                  {t}
                </li>
              ))}
            </ul>
          </motion.div>

          {/* Feature grid */}
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              { icon: Users, t: "Employee Management", d: "Workforce records, pension PINs and PFA mapping." },
              { icon: Landmark, t: "Pension Payments", d: "One consolidated payment per month." },
              { icon: Building2, t: "PFA Management", d: "Every administrator, organised in one view." },
              { icon: RefreshCcw, t: "Reconciliation", d: "Verified figures before completion." },
              { icon: FileText, t: "Reports & Receipts", d: "Statements, exports and printable receipts." },
              { icon: Zap, t: "Integrations", d: "Payroll-friendly, sandbox-ready connections." },
            ].map((f, i) => (
              <motion.div
                key={f.t}
                {...fade}
                transition={{ duration: 0.4, delay: i * 0.05 }}
                className="pen-card p-5 shadow-[0_10px_35px_-22px_rgb(11_31_42_/_0.22)]"
              >
                <span className="flex size-10 items-center justify-center rounded-lg bg-[#E6F6EF]">
                  <f.icon className="size-5 text-[#007A4D]" />
                </span>
                <h3 className="mt-3.5 text-sm font-bold text-[#0B1F2A]">{f.t}</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-[#5A6B74]">{f.d}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ================= Workflow ================= */}
      <section id="workflow" className="pen-nav relative overflow-hidden py-20 lg:py-24">
        <RouteLines />
        <div className="relative mx-auto max-w-7xl px-4 sm:px-6">
          <motion.div {...fade} transition={{ duration: 0.5 }} className="text-center">
            <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
              From payroll to RSA — in one flow
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm text-white/60 sm:text-base">
              You always know exactly where every naira is.
            </p>
          </motion.div>

          <div className="mx-auto mt-12 max-w-2xl">
            {[
              { label: "Employer", desc: "Prepares the monthly contribution" },
              { label: "Penroute", desc: "Validates, allocates and routes" },
              { label: "Employee Contributions", desc: "Each record matched to its pension PIN" },
              { label: "Pension Fund Administrators", desc: "Settlement and posting, confirmed" },
            ].map((s, i, arr) => (
              <motion.div key={s.label} {...fade} transition={{ duration: 0.4, delay: i * 0.07 }}>
                <div className="rounded-xl border border-white/10 bg-white/[0.04] p-5">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="font-bold text-white">{s.label}</p>
                      <p className="mt-0.5 text-xs text-white/55">{s.desc}</p>
                    </div>
                    <span className="text-[11px] font-bold uppercase tracking-widest text-[#00C896]">
                      0{i + 1}
                    </span>
                  </div>
                </div>
                {i < arr.length - 1 && (
                  <div className="flex justify-center py-2.5">
                    <svg width="20" height="26" viewBox="0 0 20 26" aria-hidden="true">
                      <path
                        d="M10 0 v18 M3 13 l7 8 7-8"
                        fill="none"
                        stroke="#00C896"
                        strokeOpacity="0.7"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                )}
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ================= Trust cards ================= */}
      <section id="trust" className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
        <motion.div {...fade} transition={{ duration: 0.5 }}>
          <h2 className="text-center text-3xl font-bold tracking-tight text-[#0B1F2A] sm:text-4xl">
            Why organisations choose Penroute
          </h2>
        </motion.div>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {TRUST.map((t, i) => (
            <motion.div
              key={t.title}
              {...fade}
              transition={{ duration: 0.45, delay: i * 0.07 }}
              className="pen-card p-6 shadow-[0_10px_35px_-22px_rgb(11_31_42_/_0.22)]
            >
              <span className="flex size-12 items-center justify-center rounded-xl bg-[#E6F6EF]">
                <t.icon className="size-6 text-[#007A4D]" />
              </span>
              <h3 className="mt-4 font-bold leading-snug text-[#0B1F2A]">
                {t.title} <span className="font-semibold text-[#5A6B74]">{t.sub}</span>
              </h3>
            </motion.div>
          ))}
        </div>

        {/* How it works */}
        <div className="mt-20">
          <h3 className="text-center text-2xl font-bold tracking-tight text-[#0B1F2A] sm:text-3xl">
            How it works
          </h3>
          <div className="mt-10 grid gap-5 md:grid-cols-3 lg:grid-cols-5">
            {STEPS.map((s, i) => (
              <motion.div
                key={s.n}
                {...fade}
                transition={{ duration: 0.45, delay: i * 0.06 }}
                className="pen-tile p-5 transition-transform duration-200 hover:-translate-y-0.5"
              >
                <p className="text-2xl font-bold text-[#007A4D]">{s.n}</p>
                <p className="mt-2 text-sm font-bold text-[#0B1F2A]">{s.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-[#5A6B74]">{s.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ================= Pricing ================= */}
      <section id="pricing" className="mx-auto max-w-7xl px-4 pb-20 sm:px-6">
        <motion.div {...fade} transition={{ duration: 0.5 }} className="pen-nav relative overflow-hidden rounded-2xl p-8 sm:p-12">
          <RouteLines />
          <div className="relative grid items-center gap-8 lg:grid-cols-[1.4fr_1fr]">
            <div>
              <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
                A simpler way to manage pension payments.
              </h2>
              <p className="mt-4 max-w-lg text-sm text-white/65 sm:text-base">
                Transparent per-employee pricing. No subscriptions, no hidden charges — you only
                pay for pension credits successfully processed.
              </p>
            </div>
            <div className="rounded-xl border border-white/12 bg-white/[0.05] p-6 text-center">
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#00C896]">
                Per employee credit
              </p>
              <p className="mt-2 text-5xl font-bold text-white">
                ₦9
              </p>
              <p className="mt-2 text-xs text-white/55">
                100 employees → ₦900 · 1,000 employees → ₦9,000
              </p>
              <Button
                className="mt-5 w-full bg-[#00C896] font-semibold text-[#06251B] hover:bg-[#10d6a4]"
                onClick={enter}
              >
                Get Started <ArrowRight className="size-4" />
              </Button>
            </div>
          </div>
        </motion.div>
      </section>

      {/* ================= Footer ================= */}
      <footer className="border-t border-[#E5E9EC] bg-white py-10">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-5 px-4 sm:flex-row sm:px-6">
          <Logo size="sm" />
          <p className="text-center text-xs text-[#5A6B74] sm:text-right">
            Pension contribution payment &amp; settlement infrastructure.
            <br className="sm:hidden" />
            <span className="hidden sm:inline"> · </span>
            PENCOM/PFA connections run through clearly-labelled sandbox adapters.
          </p>
        </div>
      </footer>
    </div>
  );
}
