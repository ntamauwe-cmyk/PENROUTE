# Penroute — Pension Payments. Simplified.

Nigeria's pension contribution payment, collection, reconciliation and settlement
infrastructure. Employers make **one consolidated payment**; Penroute validates,
allocates and routes every employee's contribution to the right Pension Fund
Administrator (PFA), reconciles every naira, and issues audit-ready payment
certificates.

## Core flow

```
ONE EMPLOYER PAYMENT → VALIDATION → ALLOCATION → PFA SETTLEMENT
                     → PFA POSTING CONFIRMATION → RECONCILIATION → CERTIFICATE
```

- **Employers** register once (RC, TIN, KYC), maintain their employee roster,
  upload or push monthly schedules, and authorise one payment per month.
- **Employees** are matched by RSA pension PIN and routed to their PFA.
- **PFAs** receive settlement instructions and contribution files; postings are
  only marked complete after the PFA acknowledges them.
- **Admins** configure pricing (per-employee fee), the payment rail (sandbox /
  Paystack live), and per-PFA live integration endpoints.

## Features

- Employer onboarding & workspace (multi-tenant, RC-uniqueness checked)
- Employee roster management (RSA PIN validation, PFA assignment)
- Monthly contribution wizard with **CSV schedule upload**
- **Payroll/HR API** — push schedules server-to-server (`POST /api/v1/schedules`
  with a per-employer API key generated in Settings)
- Idempotent batch/payment engine (safe retries, no duplicate money movement)
- Double-entry ledger (pension funds ≠ platform revenue)
- Live payment rail via **Paystack** (webhook + manual verify, HMAC-verified)
- Live PFA dispatch (HTTPS contribution files, HMAC signing, bounded retry)
- Reconciliation engine with exception management
- Payment certificates/receipts (print/PDF/CSV) with verification codes
- Immutable audit trail, admin console, full Nigerian PFA directory

## Tech stack

- **Frontend:** Vite · React 19 · TypeScript · Tailwind CSS v4 · shadcn/ui · Framer Motion
- **Backend:** Convex (queries/mutations/actions) · Convex Auth (email OTP)
- **Payments:** Paystack (live rail) behind a pluggable adapter contract

## Getting started

```bash
bun install
bun convex dev --once   # push Convex functions + generate types
bun run dev             # start Vite
```

Environment variables are documented in [ENV-VARIABLES.md](./ENV-VARIABLES.md).
Never commit `.env` files — secrets belong in your platform's Keys/Environment
settings (`PAYSTACK_SECRET_KEY`, Convex deployment URLs, etc.).

## Repository hygiene

`.gitignore` excludes all `.env*` files, `node_modules`, build output, and
generated Convex code (`src/convex/_generated` is regenerated with
`bun convex dev`).

## Regulatory note

Payment initiation → collection → reconciliation → allocation → settlement →
PFA posting are modelled as distinct, auditable stages. Sandbox adapters
implement the exact contracts live PENCOM / PFA / settlement integrations use;
switching to live is a configuration change per institution, not a rewrite.
