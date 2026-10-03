import '@vly-ai/integrations';
import { Toaster } from "@/components/ui/sonner";
import { RequireAuth } from "@/components/RequireAuth";
import { VlyToolbar } from "../vly-toolbar-readonly.tsx";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import React, { StrictMode, useEffect, useState, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import "./index.css";
import { adoptMasterFavicon } from "./lib/favicon";

// Swap the browser tab icon to the official uploaded master logo when present.
adoptMasterFavicon();

// Lazy load route components for better code splitting
const Landing = lazy(() => import("./pages/Landing.tsx"));
const AuthPage = lazy(() => import("./pages/Auth.tsx"));
const Overview = lazy(() => import("./pages/employer/Overview.tsx"));
const Employees = lazy(() => import("./pages/employer/Employees.tsx"));
const Batches = lazy(() => import("./pages/employer/Batches.tsx"));
const Transactions = lazy(() => import("./pages/employer/Transactions.tsx"));
const PfaDirectory = lazy(() => import("./pages/employer/PfaDirectory.tsx"));
const PfaDetail = lazy(() => import("./pages/employer/PfaDetail.tsx"));
const Reconciliation = lazy(() => import("./pages/employer/Reconciliation.tsx"));
const Statements = lazy(() => import("./pages/employer/Statements.tsx"));
const AuditTrail = lazy(() => import("./pages/employer/AuditTrail.tsx"));
const Settings = lazy(() => import("./pages/employer/Settings.tsx"));
const Onboarding = lazy(() => import("./pages/employer/Onboarding.tsx"));
const AdminConsole = lazy(() => import("./pages/employer/AdminConsole.tsx"));
const Billing = lazy(() => import("./pages/employer/Billing.tsx"));
const AdminPricing = lazy(() => import("./pages/employer/AdminPricing.tsx"));
const AdminRevenue = lazy(() => import("./pages/employer/AdminRevenue.tsx"));
const PfaPortal = lazy(() => import("./pages/pfa/PfaPortal.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

// Simple loading fallback for route transitions — brand mark, no spinners on the logo
function RouteLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <img src="/brand/penroute-mark-traced.svg" className="size-10" alt="" aria-hidden="true" />
        <div className="animate-pulse text-sm font-semibold text-muted-foreground">Loading…</div>
      </div>
    </div>
  );
}

/**
 * "Open in full window" button — only rendered when the app is embedded in the
 * editor preview iframe. Lets you pop the app out to its own browser tab
 * (full width, no editor chrome). Never shows in production or standalone use.
 */
function FullWindowButton() {
  // Detect framing once during the initial render (no effect + setState).
  const [embedded] = useState(() => {
    try {
      return window.self !== window.top;
    } catch {
      return true; // cross-origin access threw — we're framed
    }
  });
  if (!embedded) return null;
  return (
    <button
      onClick={() => window.open(window.location.href, "_blank", "noopener")}
      className="fixed bottom-20 right-4 z-[60] rounded-full bg-[#0B1F2A] px-4 py-2 text-xs font-semibold text-white shadow-lg transition-colors hover:bg-[#0B1F2A]/90 lg:bottom-6 no-print"
      title="Open the app in a full browser window"
    >
      ⤢ Full window
    </button>
  );
}

/** Silent error boundary — if VlyToolbar crashes it renders nothing instead of
 *  crashing the whole app (e.g. hook errors in WebContainer environment). */
class ToolbarErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(err: Error) {
    console.warn("[VlyToolbar] Caught error, toolbar disabled:", err.message);
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

/** Hard guard so runtime errors never leave the preview as a blank page. */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; stack: string }
> {
  state = { hasError: false, message: "", stack: "" };
  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
    };
  }
  componentDidCatch(err: Error) {
    console.error("[WebContainer preview] Root crash:", err);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">
              {import.meta.env.DEV ? "Preview runtime error" : "Something went wrong"}
            </p>
            <p className="mt-2 text-xs text-muted-foreground break-words">
              {this.state.message}
            </p>
            {/* Stack traces are developer-only debug output — never shown in production builds. */}
            {this.state.stack && import.meta.env.DEV && (
              <pre className="mt-3 text-left text-[10px] leading-4 text-muted-foreground/80 max-h-40 overflow-auto rounded border border-border/60 p-2">
                {this.state.stack}
              </pre>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);



function RouteSyncer() {
  const location = useLocation();
  useEffect(() => {
    window.parent.postMessage(
      { type: "iframe-route-change", path: location.pathname },
      "*",
    );
  }, [location.pathname]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "navigate") {
        if (event.data.direction === "back") window.history.back();
        if (event.data.direction === "forward") window.history.forward();
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return null;
}


createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <ToolbarErrorBoundary>
        <VlyToolbar />
      </ToolbarErrorBoundary>
      <ConvexAuthProvider client={convex}>
        <BrowserRouter>
          <RouteSyncer />
          <FullWindowButton />
          <Suspense fallback={<RouteLoading />}>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route
                path="/auth"
                element={<AuthPage redirectAfterAuth="/dashboard" />}
              />
              <Route
                path="/dashboard"
                element={
                  <RequireAuth>
                    <Overview />
                  </RequireAuth>
                }
              />
              <Route
                path="/dashboard/employees"
                element={
                  <RequireAuth>
                    <Employees />
                  </RequireAuth>
                }
              />
              <Route
                path="/dashboard/batches"
                element={
                  <RequireAuth>
                    <Batches />
                  </RequireAuth>
                }
              />
              <Route
                path="/dashboard/transactions"
                element={
                  <RequireAuth>
                    <Transactions />
                  </RequireAuth>
                }
              />
              <Route
                path="/dashboard/pfas"
                element={
                  <RequireAuth>
                    <PfaDirectory />
                  </RequireAuth>
                }
              />
              <Route
                path="/dashboard/pfas/:pfaId"
                element={
                  <RequireAuth>
                    <PfaDetail />
                  </RequireAuth>
                }
              />
              <Route
                path="/dashboard/reconciliation"
                element={
                  <RequireAuth>
                    <Reconciliation />
                  </RequireAuth>
                }
              />
              <Route
                path="/dashboard/statements"
                element={
                  <RequireAuth>
                    <Statements />
                  </RequireAuth>
                }
              />
              <Route
                path="/dashboard/audit"
                element={
                  <RequireAuth>
                    <AuditTrail />
                  </RequireAuth>
                }
              />
              <Route
                path="/dashboard/settings"
                element={
                  <RequireAuth>
                    <Settings />
                  </RequireAuth>
                }
              />
              <Route
                path="/onboarding"
                element={
                  <RequireAuth>
                    <Onboarding />
                  </RequireAuth>
                }
              />
              <Route
                path="/admin"
                element={
                  <RequireAuth>
                    <AdminConsole />
                  </RequireAuth>
                }
              />
              <Route
                path="/dashboard/billing"
                element={
                  <RequireAuth>
                    <Billing />
                  </RequireAuth>
                }
              />
              <Route
                path="/admin/pricing"
                element={
                  <RequireAuth>
                    <AdminPricing />
                  </RequireAuth>
                }
              />
              <Route
                path="/admin/revenue"
                element={
                  <RequireAuth>
                    <AdminRevenue />
                  </RequireAuth>
                }
              />
              <Route
                path="/pfa"
                element={
                  <RequireAuth>
                    <PfaPortal section="home" />
                  </RequireAuth>
                }
              />
              <Route
                path="/pfa/settlements"
                element={
                  <RequireAuth>
                    <PfaPortal section="settlements" />
                  </RequireAuth>
                }
              />
              <Route
                path="/pfa/contributions"
                element={
                  <RequireAuth>
                    <PfaPortal section="contributions" />
                  </RequireAuth>
                }
              />
              <Route
                path="/pfa/employees"
                element={
                  <RequireAuth>
                    <PfaPortal section="employees" />
                  </RequireAuth>
                }
              />
              <Route
                path="/pfa/employers"
                element={
                  <RequireAuth>
                    <PfaPortal section="employers" />
                  </RequireAuth>
                }
              />
              <Route
                path="/pfa/exceptions"
                element={
                  <RequireAuth>
                    <PfaPortal section="exceptions" />
                  </RequireAuth>
                }
              />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
        <Toaster />
      </ConvexAuthProvider>
    </RootErrorBoundary>
  </StrictMode>,
);
