# Penroute — Environment Variables

Secrets are **never committed** to this repository. Configure them in your hosting platform's
Keys/Environment settings (on Freebuff: the Keys/API keys tab). Copy this file to `.env` locally
and fill in your own values if you self-host.

## Frontend (Vite — safe to expose to the browser)

| Variable | Purpose |
|---|---|
| `VITE_CONVEX_URL` | Your Convex deployment URL (e.g. `https://<deployment>.convex.cloud`) — set by `bun convex dev` |

## Backend / server-side (Convex)

| Variable | Purpose |
|---|---|
| `CONVEX_SITE_URL` | Convex site URL used by Convex Auth OIDC (`auth.config.ts`) |
| `PAYSTACK_SECRET_KEY` | Live payment rail. `sk_test_…` to trial, `sk_live_…` for production. Set in the Keys tab; the Admin console reads it via `process.env` |
| `GITHUB_TOKEN` | GitHub personal access token (**classic**, with the `repo` scope) used by Settings → GitHub repository sync to commit the project source to your existing repository. Set in the Keys tab; read server-side only |
| `VLY_INTEGRATION_KEY` | Freebuff integration gateway token (injected by the platform) |
| `VLY_INTEGRATION_BASE_URL` | Freebuff integration gateway base URL (injected by the platform) |
| `VLY_CONVEX_AUTH_ISSUER` | Freebuff federated-auth issuer (injected by the platform) |
| `VLY_APP_NAME` | App name used in OTP emails (injected by the platform) |
| `EMAIL_OTP_API_KEY` | Optional override for the Freebuff email-OTP relay key used by `auth/emailOtp.ts`. Leave unset to use the built-in platform key; set it in the Keys tab to rotate the relay key without a code change |
| `VITE_VLY_APP_ID` / `VITE_VLY_MONITORING_URL` | Freebuff preview/error monitoring (injected by the platform) |

## PFA live integrations

PFA contribution-file endpoints and API secrets are **not** environment variables — they are
configured per-PFA in the **Admin console → PFA integrations**, stored server-side only
(`pfas.endpointConfig`), and are never returned by any query or included in any client payload.

## Payroll/HR API keys

Employer payroll integration keys (`penr_live_…`) are generated in **Settings → Payroll / HR
integration**, stored server-side only on the employer record, shown exactly once, and stripped
from every query response. They are never committed.
