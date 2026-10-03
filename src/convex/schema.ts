import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove

      // platform extensions
      employerId: v.optional(v.id("employers")), // link for employer-portal users
      pfaId: v.optional(v.id("pfas")), // link for PFA-portal users
    }).index("email", ["email"]),

    // ------------------------------------------------------------------
    // Employers (KYB)
    // ------------------------------------------------------------------
    employers: defineTable({
      name: v.string(),
      rcNumber: v.string(),
      tin: v.string(),
      registeredAddress: v.string(),
      contactEmail: v.string(),
      contactPhone: v.string(),
      representativeName: v.string(),
      // status: pending | under_review | active | suspended
      status: v.string(),
      kycStatus: v.string(), // unverified | in_review | verified | rejected
      // which user created/owns this employer record
      ownerUserId: v.optional(v.id("users")),
      // Payroll/HR API integration key (spec §4). Server-side only — stripped
      // from every query response before it reaches any client.
      apiKey: v.optional(v.string()),
      apiKeyCreatedAt: v.optional(v.number()),
      createdAt: v.number(),
    })
      .index("by_rc", ["rcNumber"])
      .index("by_owner", ["ownerUserId"])
      .index("by_status", ["status"]),

    // ------------------------------------------------------------------
    // PFAs — Pension Fund Administrators directory (master/reference data)
    // `slug` is the immutable internal identifier (never the display name).
    // All contact/website/logo fields stay null until verified — never invent.
    // ------------------------------------------------------------------
    pfas: defineTable({
      name: v.string(),
      code: v.string(), // Penroute reference code, e.g. "101" — NOT an official PenCom number
      slug: v.optional(v.string()), // immutable master id, e.g. "access_pensions"
      legalName: v.optional(v.string()),
      shortName: v.optional(v.string()),
      // pencom_status: LICENSED for current licensed PFAs (undefined for retired legacy rows)
      pencomStatus: v.optional(v.string()),
      // status: ACTIVE | INACTIVE (soft deactivation only — never delete a PFA)
      status: v.optional(v.string()),
      // integration_status: not_integrated | sandbox | pending_approval | production
      // Defaults to not_integrated — never auto-marked as integrated.
      integrationStatus: v.optional(v.string()),
      logoUrl: v.optional(v.string()), // null until an approved asset exists
      websiteUrl: v.optional(v.string()), // null until verified
      supportEmail: v.optional(v.string()), // null until verified
      supportPhone: v.optional(v.string()), // null until verified
      headquartersAddress: v.optional(v.string()), // null until verified
      // integration: sandbox_adapter | live_api | manual
      integrationMode: v.string(),
      active: v.boolean(),
      // reserved for approved live integration credentials — never exposed to frontend
      endpointConfig: v.optional(v.object({})),
      createdAt: v.number(),
      updatedAt: v.optional(v.number()),
    })
      .index("by_code", ["code"])
      .index("by_slug", ["slug"])
      .index("by_status", ["status"]),

    // ------------------------------------------------------------------
    // Employees / pension data
    // ------------------------------------------------------------------
    employees: defineTable({
      employerId: v.id("employers"),
      employeeCode: v.string(),
      fullName: v.string(),
      pensionPin: v.string(), // RSA PIN
      pfaId: v.id("pfas"),
      active: v.boolean(),
      createdAt: v.number(),
    })
      .index("by_employer", ["employerId"])
      .index("by_pin", ["pensionPin"])
      .index("by_pfa", ["pfaId"])
      .index("by_employer_pin", ["employerId", "pensionPin"]),

    // ------------------------------------------------------------------
    // Contribution batches (one per employer per contribution month)
    // ------------------------------------------------------------------
    contributionBatches: defineTable({
      employerId: v.id("employers"),
      batchRef: v.string(), // e.g. RAE-BATCH-2026-08-A1B2
      fingerprint: v.string(), // idempotency fingerprint
      contributionMonth: v.number(), // 1..12
      contributionYear: v.number(),
      employeeCount: v.number(),
      totalEmployeeContribution: v.number(), // kobo-precise (naira x100)
      totalEmployerContribution: v.number(),
      totalPensionAmount: v.number(),
      platformFee: v.number(), // fee in kobo
      totalDebit: v.number(), // pension + fee
      status: v.string(), // draft | awaiting_payment | processing | completed | failed
      paymentStatus: v.string(), // pending | initiated | processing | successful | failed | reversed
      allocationStatus: v.string(), // pending | validated | allocating | partially_allocated | allocated | allocation_failed
      settlementStatus: v.string(), // pending | processing | partially_settled | settled | failed | reversed
      pfaStatus: v.string(), // awaiting_ack | received | accepted | rejected | posted | reconciliation_pending | reconciled
      reconciliationStatus: v.string(), // pending | reconciled | exception
      paymentRef: v.optional(v.string()),
      paymentDate: v.optional(v.number()),
      completedAt: v.optional(v.number()),
      createdAt: v.number(),
      createdBy: v.optional(v.id("users")),
    })
      .index("by_employer", ["employerId"])
      .index("by_fingerprint", ["fingerprint"])
      .index("by_period", ["contributionYear", "contributionMonth"])
      .index("by_ref", ["batchRef"]),

    // Individual employee contribution records within a batch
    contributionRecords: defineTable({
      batchId: v.id("contributionBatches"),
      employerId: v.id("employers"),
      employeeId: v.optional(v.id("employees")), // null when unknown at intake
      fullName: v.string(),
      employeeCode: v.string(),
      pensionPin: v.string(),
      pfaId: v.id("pfas"),
      employeeContribution: v.number(), // kobo
      employerContribution: v.number(), // kobo
      totalAmount: v.number(),
      contributionMonth: v.number(),
      contributionYear: v.number(),
      // validation: pending | valid | invalid
      validationStatus: v.string(),
      validationError: v.optional(v.string()),
      allocationStatus: v.string(), // pending | allocated | allocation_failed
      settlementStatus: v.string(), // pending | settled | failed
      pfaStatus: v.string(), // awaiting_ack | received | accepted | posted | rejected
      recordRef: v.string(),
      createdAt: v.number(),
    })
      .index("by_batch", ["batchId"])
      .index("by_employer", ["employerId"])
      .index("by_pfa", ["pfaId"])
      .index("by_pfa_batch", ["pfaId", "batchId"])
      .index("by_pin_period", ["pensionPin", "contributionYear", "contributionMonth"]),

    // ------------------------------------------------------------------
    // Payments — the ONE consolidated employer payment
    // ------------------------------------------------------------------
    payments: defineTable({
      batchId: v.id("contributionBatches"),
      employerId: v.id("employers"),
      paymentRef: v.string(),
      idempotencyKey: v.string(),
      amount: v.number(), // total debit (pension + fee) in kobo
      pensionAmount: v.number(),
      platformFee: v.number(),
      // rail: sandbox_transfer | card | bank_transfer | nibss ...
      rail: v.string(),
      // pending | initiated | processing | successful | failed | reversed
      status: v.string(),
      providerRef: v.optional(v.string()),
      failureReason: v.optional(v.string()),
      initiatedAt: v.number(),
      confirmedAt: v.optional(v.number()),
    })
      .index("by_batch", ["batchId"])
      .index("by_employer", ["employerId"])
      .index("by_ref", ["paymentRef"])
      .index("by_idem", ["idempotencyKey"]),

    // PFA settlement instructions
    settlements: defineTable({
      batchId: v.id("contributionBatches"),
      paymentId: v.id("payments"),
      pfaId: v.id("pfas"),
      settlementRef: v.string(),
      amount: v.number(),
      employeeCount: v.number(),
      // pending | processing | settled | failed
      status: v.string(),
      instructedAt: v.number(),
      confirmedAt: v.optional(v.number()),
      failureReason: v.optional(v.string()),
      // live-API deliveries attempted (bounded retry loop, spec §40)
      dispatchAttempts: v.optional(v.number()),
    })
      .index("by_batch", ["batchId"])
      .index("by_pfa", ["pfaId"]),

    // PFA acknowledgements / posting confirmations (from PFA infra)
    pfaAcknowledgements: defineTable({
      settlementId: v.id("settlements"),
      batchId: v.id("contributionBatches"),
      pfaId: v.id("pfas"),
      // received | accepted | rejected | partially_accepted | processing | posted | failed | reconciled
      status: v.string(),
      message: v.optional(v.string()),
      acceptedCount: v.optional(v.number()),
      rejectedCount: v.optional(v.number()),
      receivedAt: v.number(),
    })
      .index("by_settlement", ["settlementId"])
      .index("by_batch", ["batchId"]),

    // ------------------------------------------------------------------
    // Double-entry ledger — financial source of truth
    // ------------------------------------------------------------------
    ledgerEntries: defineTable({
      entryRef: v.string(),
      batchId: v.optional(v.id("contributionBatches")),
      paymentId: v.optional(v.id("payments")),
      employerId: v.optional(v.id("employers")),
      pfaId: v.optional(v.id("pfas")),
      // account: employer_debit | clearing | pfa_payable | platform_revenue | settlement_clearing
      account: v.string(),
      debit: v.number(), // kobo; one of debit/credit is 0
      credit: v.number(),
      currency: v.string(), // NGN
      narration: v.string(),
      reconciliationStatus: v.string(), // pending | reconciled | exception
      entryDate: v.number(),
    })
      .index("by_batch", ["batchId"])
      .index("by_employer", ["employerId"])
      .index("by_account", ["account"])
      .index("by_pfa", ["pfaId"])
      .index("by_ref", ["entryRef"]),

    // Platform fee configuration — admin configurable, never hard-coded
    systemConfig: defineTable({
      key: v.string(),
      value: v.number(),
      updatedAt: v.number(),
      updatedBy: v.optional(v.string()),
    }).index("by_key", ["key"]),

    // ------------------------------------------------------------------
    // Exceptions — reconciliation/validation issues
    // ------------------------------------------------------------------
    exceptions: defineTable({
      batchId: v.optional(v.id("contributionBatches")),
      employerId: v.optional(v.id("employers")),
      pfaId: v.optional(v.id("pfas")),
      exceptionRef: v.string(),
      // invalid_pin | unknown_pfa | duplicate_contribution | payment_mismatch | settlement_failed | pfa_rejection | reconciliation_mismatch
      type: v.string(),
      description: v.string(),
      amount: v.optional(v.number()),
      // open | investigating | resolved
      status: v.string(),
      responsibleParty: v.string(), // employer | platform | pfa | pencom
      resolutionNotes: v.optional(v.string()),
      createdAt: v.number(),
      resolvedAt: v.optional(v.number()),
    })
      .index("by_batch", ["batchId"])
      .index("by_employer", ["employerId"])
      .index("by_pfa", ["pfaId"])
      .index("by_status", ["status"])
      .index("by_ref", ["exceptionRef"]),

    // ------------------------------------------------------------------
    // Audit trail — immutable
    // ------------------------------------------------------------------
    auditLogs: defineTable({
      actor: v.string(), // user email or "system"
      action: v.string(),
      entityType: v.string(),
      entityId: v.optional(v.string()),
      employerId: v.optional(v.id("employers")),
      batchId: v.optional(v.id("contributionBatches")),
      details: v.optional(v.string()),
      // machine-readable previous/new values for administrative changes
      field: v.optional(v.string()),
      before: v.optional(v.string()),
      after: v.optional(v.string()),
      createdAt: v.number(),
    })
      .index("by_batch", ["batchId"])
      .index("by_employer", ["employerId"]),

    // Sandbox/production adapter call log (PFA + PENCOM adapters)
    integrationLogs: defineTable({
      adapter: v.string(), // pfa_sandbox | pencom_sandbox | pfa_live | pencom_live
      operation: v.string(),
      requestSummary: v.string(),
      responseSummary: v.string(),
      success: v.boolean(),
      batchId: v.optional(v.id("contributionBatches")),
      createdAt: v.number(),
    }).index("by_batch", ["batchId"]),

    // Webhook delivery log (employer-facing event feed)
    webhookEvents: defineTable({
      employerId: v.optional(v.id("employers")),
      batchId: v.optional(v.id("contributionBatches")),
      eventType: v.string(),
      payload: v.string(),
      // pending | delivered | failed
      status: v.string(),
      createdAt: v.number(),
    }).index("by_batch", ["batchId"]),

    // ------------------------------------------------------------------
    // GitHub sync — staged files for committing the project source to the
    // user's existing repository via the GitHub Git Data API (one commit).
    // ------------------------------------------------------------------
    githubPushFiles: defineTable({
      pushId: v.string(), // groups one push attempt
      path: v.string(), // repo-relative path
      contentBase64: v.string(),
      sha256: v.string(),
      bytes: v.number(),
      // pending | staged | committed
      status: v.string(),
      createdAt: v.number(),
    })
      .index("by_push", ["pushId"])
      .index("by_push_status", ["pushId", "status"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
