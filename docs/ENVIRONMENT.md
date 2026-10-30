# Penroute — Environment, Configuration & Deployment Readiness

> Environment variables are managed in two places: **local frontend config**
> (`.env`, never committed; `.env.example` lists the local keys) and the
> **Convex deployment environment** (platform *Keys / API keys* tab, server
> side only, never in the repository). No secret values are committed anywhere
> in this repository (verified by secret scanning in CI and by
> `scripts/test-security.ts`).

## Required variables

| Key | Where | Required | Purpose |
| --- | --- | --- | --- |
| `VITE_CONVEX_URL` | local `.env` | yes (local/dev) | Frontend Convex client URL |
| `CONVEX_SITE_URL` | Convex deployment env | yes | Auth issuer / OIDC discovery base (`/.well-known/openid-configuration`) |
| `CONVEX_DEPLOYMENT` | local `.env` | yes (local/dev) | Target deployment for `convex dev` |
| `GITHUB_TOKEN` | Convex deployment env (Keys tab) | for GitHub sync | Classic PAT with **`repo` + `workflow`** scopes; used only by internal/admin-gated sync & PR actions |
| `PAYSTACK_SECRET_KEY` | Convex deployment env (Keys tab) | for live payments | `sk_test_…` sandbox / `sk_live_…` production; webhook HMAC verification |
| `EMAIL_OTP_API_KEY` | Convex deployment env | legacy fallback only | OTP email relay key. No longer hard-coded: without it, sign-in codes cannot be sent. The previously committed key is public in git history — rotate it. |
| `RESEND_API_KEY` | Convex deployment env | **yes** (email) | Resend API key — sends sign-in codes and employer notification emails. Replaces the Freebuff OTP relay. |
| `NOTIFY_FROM_EMAIL` | Convex deployment env | **yes** (email) | Sender, e.g. `Penroute <no-reply@penroute.net>` (domain verified in Resend). |
| `PENROUTE_APP_URL` | Convex deployment env | optional | Public app URL used in email links (default `https://penroute.net`). |
| `PENROUTE_SANDBOX_MODE` | Convex deployment env | dev/preview only | `enabled` marks a NON-production deployment: allows the simulated sandbox payment rail, sandbox PFA acknowledgements, demo seeding and guest workspaces. **Never set on production.** Unset = production behaviour (fail closed). |
| `PENROUTE_BOOTSTRAP_ADMIN_EMAILS` | Convex deployment env | first launch | Comma-separated operator emails allowed to claim the one-time platform-admin bootstrap. Unset = nobody can self-claim admin (use `npx convex run admin:grantPlatformAdmin '{"email":"…"}'`). |
| `VLY_CONVEX_AUTH_ISSUER` | Convex deployment env | Freebuff previews only | When set, tokens from this issuer are trusted for sign-in. Leave UNSET on production — no third-party issuer is trusted by default. |
| `VLY_APP_NAME`, `VLY_APP_ID`, `VLY_INTEGRATION_KEY` | Convex deployment env | optional | Freebuff branding/integration (not required in production) |
| `VLY_MONITORING_URL` | Convex deployment env | optional | Telemetry sink; no-op when unset |

## Fail-safe behaviour when configuration is missing (verified in source)

| Feature missing key | Behaviour |
| --- | --- |
| `PAYSTACK_SECRET_KEY` | Webhook returns **401** for every delivery (fails closed); the admin console refuses to enable the live rail; on production no payment can be made (the sandbox rail requires `PENROUTE_SANDBOX_MODE=enabled`) |
| `GITHUB_TOKEN` | Sync/PR actions throw a descriptive configuration error; no repository call is attempted |
| `EMAIL_OTP_API_KEY` | Built-in platform relay key keeps sign-in working (rotatable without a code change) |
| `CONVEX_SITE_URL` | Auth OIDC routes cannot register; sign-in cannot confirm (deployment misconfiguration surfaces immediately) |

## Environment separation

- **Development**: Convex *dev* deployment + local Vite preview; demo/anonymous
  sign-in is available only in `import.meta.env.DEV` builds.
- **Production**: Convex *prod* deployment (its own database, keys and URL);
  `sk_live` Paystack key, KYB-approved employers, and real PFA integrations are
  separate opt-ins. No workflow on `main` deploys anything — releases are
  explicit manual steps.

## Database & migration safety

- Schema is Convex-managed; all changes this release were additive
  (optional fields + one new index). No destructive migrations, no table
  drops, no data rewrites.
- Legacy payroll API keys are migrated **in place on successful auth only**
  (plaintext → SHA-256 hash); a failed auth never rewrites the row.

## Logging, monitoring, backups

- Convex dashboard provides function logs, errors and metrics per deployment.
- `VLY_MONITORING_URL` is an optional external sink (no-op when unset).
- Backups/pitr are whatever the Convex deployment provides — verify and
  configure retention on the production deployment before launch (manual step).

## Deployment process (manual steps)

1. All checks green locally and in CI (`bunx tsc -b --noEmit`, `bun run lint`,
   `test:security`, `test:pricing`, `test:auth`, `test:authz`, `vite build`,
   Playwright).
2. Push to `main` via the audited GitHub sync actions (branch protection
   requires the CI check to pass on PRs).
3. `bunx convex dev --once --prod`-style push for the production Convex
   deployment (operator action, not automated here).
4. Configure production keys in the Keys tab: `PAYSTACK_SECRET_KEY=sk_live_…`,
   `GITHUB_TOKEN` (repo+workflow), relay override if rotating.
5. Real-world verification still required (see final audit report): KYB
   evidence review, live Paystack transaction, operational PFA connection.
