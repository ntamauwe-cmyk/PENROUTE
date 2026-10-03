import { useAuth } from "@/hooks/use-auth";
import { useEmployer } from "@/components/pension-ui";
import { Button } from "@/components/ui/button";
import { Logo, PenrouteSymbol } from "@/components/Brand";
import { api } from "@/convex/_generated/api";
import {
  Building2,
  Landmark,
  LayoutDashboard,
  LineChart,
  type LucideIcon,
  ScrollText,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useState } from "react";
import { useQuery } from "convex/react";
import { Link, useLocation, useNavigate } from "react-router";

type NavGroup = "Workspace" | "Control";
type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean; group: NavGroup };

const EMPLOYER_NAV: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, end: true, group: "Workspace" },
  { to: "/dashboard/employees", label: "Employees", icon: Users, group: "Workspace" },
  { to: "/dashboard/batches", label: "Pension Payments", icon: Landmark, group: "Workspace" },
  { to: "/dashboard/transactions", label: "Transactions", icon: ScrollText, group: "Workspace" },
  { to: "/dashboard/pfas", label: "PFA Directory", icon: Landmark, group: "Workspace" },
  { to: "/dashboard/reconciliation", label: "Reconciliation", icon: ShieldCheck, group: "Workspace" },
  { to: "/dashboard/statements", label: "Reports", icon: LineChart, group: "Workspace" },
  { to: "/dashboard/audit", label: "Audit Logs", icon: ScrollText, group: "Control" },
  { to: "/dashboard/settings", label: "Settings", icon: ShieldCheck, group: "Control" },
  { to: "/onboarding", label: "Register company", icon: Users, group: "Control" },
  { to: "/admin", label: "Admin console", icon: ShieldCheck, group: "Control" },
];

// PFA-portal navigation — only ever shows this operator's own scoped pages.
const PFA_NAV: NavItem[] = [
  { to: "/pfa", label: "Overview", icon: LayoutDashboard, end: true, group: "Workspace" },
  { to: "/pfa/settlements", label: "Settlements", icon: Landmark, group: "Workspace" },
  { to: "/pfa/contributions", label: "Contributions", icon: ScrollText, group: "Workspace" },
  { to: "/pfa/employees", label: "Members", icon: Users, group: "Workspace" },
  { to: "/pfa/employers", label: "Employers", icon: Building2, group: "Control" },
  { to: "/pfa/exceptions", label: "Exceptions", icon: ShieldCheck, group: "Control" },
];

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const { employer } = useEmployer();
  const pfaSession = useQuery(api.pfaPortal.getSession);
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const isPfa = user?.role === "pfa";
  const home = isPfa ? "/pfa" : "/dashboard";
  const navItems = (isPfa ? PFA_NAV : EMPLOYER_NAV).filter(
    (item) => item.to !== "/admin" || user?.role === "admin",
  );

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const isActive = (item: NavItem) =>
    item.end ? location.pathname === item.to : location.pathname.startsWith(item.to);

  const navLinks = (onClick?: () => void, group?: NavGroup) =>
    navItems.filter((item) => !group || item.group === group).map((item) => {
      const Icon = item.icon;
      return (
        <Link
          key={item.to}
          to={item.to}
          onClick={onClick}
          data-active={isActive(item)}
          className="pen-nav-link"
        >
          <Icon className="pen-nav-icon size-5" />
          {item.label}
        </Link>
      );
    });

  const initials = (user?.email ?? "?").slice(0, 2).toUpperCase();
  const orgLine = isPfa
    ? pfaSession?.pfa.name ?? "PFA portal"
    : employer
      ? `RC ${employer.rcNumber}`
      : "No organisation";

  return (
    <div className="min-h-screen bg-background">
      {/* ===== Desktop navy sidebar (reference dashboard) ===== */}
      <aside className="pen-nav pen-sidebar-nav fixed inset-y-0 left-0 z-40 hidden w-64 flex-col lg:flex no-print">
        <div className="px-5 pb-5 pt-7">
          <Link to={home} aria-label="Penroute" className="inline-block">
            <Logo onDark tagline />
          </Link>
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3">
          {(["Workspace", "Control"] as NavGroup[]).map((group, gi) => {
            const groupLinks = navLinks(undefined, group);
            if (groupLinks.length === 0) return null;
            return (
              <div key={group} className="contents">
                {gi > 0 && <div className="pen-brand-divider" />}
                <div className="pen-sidebar-label">{group}</div>
                {groupLinks}
              </div>
            );
          })}
        </nav>
        <div className="border-t border-white/10 p-4">
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-sm font-bold text-white">
              {initials}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-semibold text-white">{user?.email ?? "Guest"}</p>
              <p className="truncate text-sm text-white/55">{orgLine}</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-3 w-full justify-start text-white/70 hover:bg-white/10 hover:text-white"
            onClick={handleSignOut}
          >
            Sign out
          </Button>
        </div>
      </aside>

      {/* ===== Mobile top bar — symbol-only mark at narrow widths ===== */}
      <header className="pen-nav pen-sidebar-nav sticky top-0 z-40 flex items-center justify-between px-4 py-3 lg:hidden no-print">
        <Link to={home} aria-label="Penroute" className="flex items-center">
          <PenrouteSymbol className="size-8" />
        </Link>
        <button
          className="rounded-lg px-3 py-2 text-sm font-semibold text-white"
          onClick={() => setMobileOpen((v) => !v)}
        >
          {mobileOpen ? "Close" : "Menu"}
        </button>
      </header>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden no-print">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <nav className="pen-nav pen-flow pen-sidebar-nav absolute left-3 right-3 top-16 flex flex-col gap-1 p-3 shadow-2xl">
            {navLinks(() => setMobileOpen(false))}
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 justify-start text-white/70 hover:bg-white/10 hover:text-white"
              onClick={() => {
                setMobileOpen(false);
                void handleSignOut();
              }}
            >
              Sign out
            </Button>
          </nav>
        </div>
      )}

      {/* ===== Content ===== */}
      <div className="lg:pl-64">
        <main className="mx-auto w-full max-w-7xl space-y-7 px-4 pb-28 pt-6 sm:px-6 lg:pb-16 lg:pt-8">
          {children}
        </main>
      </div>

      {/* ===== Mobile bottom navigation (reference mobile screen) ===== */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-border bg-white/95 backdrop-blur lg:hidden no-print"
        aria-label="Primary"
      >
        {(
          isPfa
            ? [
                { to: "/pfa", label: "Home", icon: LayoutDashboard, exact: true },
                { to: "/pfa/settlements", label: "Settlements", icon: Landmark, exact: false },
                { to: "/pfa/contributions", label: "Credits", icon: ScrollText, exact: false },
                { to: "/pfa/employees", label: "Members", icon: Users, exact: false },
              ]
            : [
                { to: "/dashboard", label: "Home", icon: LayoutDashboard, exact: true },
                { to: "/dashboard/batches", label: "Payments", icon: Landmark, exact: false },
                { to: "/dashboard/statements", label: "Reports", icon: LineChart, exact: false },
                { to: "/dashboard/settings", label: "Profile", icon: Users, exact: false },
              ]
        ).map((t) => {
          const Icon = t.icon;
          const active = t.exact
            ? location.pathname === t.to
            : location.pathname.startsWith(t.to);
          return (
            <Link
              key={t.to}
              to={t.to}
              className={`flex flex-col items-center gap-1 py-3 text-[11px] font-semibold transition-colors ${
                active ? "text-[#007A4D]" : "text-muted-foreground"
              }`}
            >
              <Icon className="size-5" />
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export { PenrouteSymbol };
