import { ConvexError } from "convex/values";
// ============================================================================
// DEPLOYMENT ENVIRONMENT FLAGS — fail closed.
// ----------------------------------------------------------------------------
// PENROUTE_SANDBOX_MODE=enabled marks a NON-PRODUCTION deployment (local dev,
// preview, demo). Only then may the platform:
//   - "collect" a payment through the simulated sandbox rail,
//   - synthesise sandbox PFA settlement/acknowledgement/posting results,
//   - seed or claim the demo employer workspace.
// When the variable is absent (the production default), every one of those
// paths is refused: a payment is only successful when Paystack confirms it,
// and a PFA settlement is only "settled" when a live PFA integration or an
// authorised operator confirms it.
// ============================================================================

export function sandboxModeEnabled(): boolean {
  return (process.env.PENROUTE_SANDBOX_MODE ?? "").trim().toLowerCase() === "enabled";
}

export function requireSandboxMode(what: string): void {
  if (!sandboxModeEnabled()) {
    throw new ConvexError(
      `${what} is only available on sandbox deployments (PENROUTE_SANDBOX_MODE=enabled). ` +
        "This deployment is configured for production.",
    );
  }
}

/** Operator emails allowed to claim the one-time platform-admin bootstrap. */
export function bootstrapAdminEmails(): Set<string> {
  return new Set(
    (process.env.PENROUTE_BOOTSTRAP_ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 3 && e.includes("@")),
  );
}
