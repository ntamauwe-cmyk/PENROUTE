# Run Penroute on your own computer (Windows)

This folder is a full copy of the Penroute GitHub repository (branch
`production-readiness/verified-fixes`, with git history), independent of Freebuff.

## 1. Prerequisites (one time)
- **Bun** — already installed on this PC (`bun --version` to check). If not: `powershell -c "irm bun.sh/install.ps1 | iex"`
- **Node.js 20+** — https://nodejs.org (needed by the Convex CLI)
- A free **Convex** account — https://dashboard.convex.dev (sign in with GitHub)

## 2. Install
Open PowerShell in this folder and run:
```powershell
bun install
node scripts/generate-github-manifest.mjs
```

## 3. Create YOUR backend (Convex) — replaces the Freebuff-hosted one
```powershell
npx convex dev
```
- Log in when prompted, choose **create a new project** (e.g. `penroute-dev`).
- This writes `.env.local` (with `VITE_CONVEX_URL`) and pushes all backend functions.
- Leave it running in this window.

Note: data stored in the old Freebuff-hosted Convex database does **not** move
automatically — that deployment belongs to Freebuff's account. If you need it,
export it from the Freebuff project (Convex dashboard → Data → Export) and
import with `npx convex import`.

## 4. Configure the development deployment (second PowerShell window)
```powershell
npx convex env set PENROUTE_SANDBOX_MODE enabled          # DEV ONLY: simulated payments + demo data
npx convex env set PENROUTE_BOOTSTRAP_ADMIN_EMAILS you@yourcompany.com
npx convex env set EMAIL_OTP_API_KEY <your OTP relay key> # needed to email sign-in codes
npx convex run pfaDirectory:seedDirectory                  # load the 19 licensed PFAs
```
`CONVEX_SITE_URL` and `JWT_PRIVATE_KEY`/`JWKS` for sign-in: run once
```powershell
npx @convex-dev/auth
```
and follow its prompts (it sets the auth keys on your deployment).

## 5. Start the web app
```powershell
bun run dev
```
Open http://localhost:5173 — sign in with the email you put in
`PENROUTE_BOOTSTRAP_ADMIN_EMAILS`, then claim platform admin.

## 6. Run the tests
```powershell
bunx tsc -b --noEmit
bun run test:backend      # 27 backend integration tests
bun scripts/test-security.ts
bun scripts/test-pricing.ts
```

## 7. Going to production on penroute.net (later)
1. `npx convex deploy` → creates the production Convex deployment.
   Set `EMAIL_OTP_API_KEY`, `PAYSTACK_SECRET_KEY`, `PENROUTE_BOOTSTRAP_ADMIN_EMAILS`
   on it with `npx convex env set --prod ...` — **never** `PENROUTE_SANDBOX_MODE`.
2. Host the frontend (`bun run build` → `dist/`) on Vercel, Netlify or Cloudflare Pages,
   with `VITE_CONVEX_URL` = the production Convex URL.
3. In Cloudflare DNS for penroute.net, point the domain at that host
   (currently it returns error 522 — nothing is answering behind Cloudflare).
4. In Paystack, register the webhook `https://<prod-deployment>.convex.site/webhooks/paystack`.
