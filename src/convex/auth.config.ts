import type { AuthConfig } from "convex/server";

// Penroute trusts exactly one identity issuer: its own Convex Auth sign-in
// (email one-time codes, see src/convex/auth.ts). The deployment self-issues
// JWTs (iss = CONVEX_SITE_URL, a built-in Convex variable) validated via OIDC
// discovery at `${domain}/.well-known/openid-configuration`, served by
// auth.addHttpRoutes() in convex/http.ts. No third-party issuer (the former
// Freebuff federated sign-in) is trusted.
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL!,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;
