import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { getCurrentUser } from "./users";
import { audit } from "./employers";
import { integrationStatusLabel, isSelectable } from "./pfaDirectory";

// ============================================================================
// PFA PORTAL (role: "pfa") — a signed-in PFA operator sees ONLY the data of
// the single PFA they are linked to (`users.pfaId`).
//
// SCOPING RULE: every read below derives pfaId from the SESSION, never from
// client arguments, so one PFA can never read another PFA's rows — even by
// calling the functions directly.
//
// ACCESS RULE: the only paths into role "pfa" are (a) an administrator
// linking an existing account, or (b) an administrator-created access grant
// claimed on first sign-in. Self-service sign-in never yields PFA access.
// ============================================================================

async function requirePfaUser(ctx: QueryCtx): Promise<Doc<"users">> {
  const user = await getCurrentUser(ctx);
  if (!user) throw new Error("Not authenticated");
  if (user.role !== "pfa" || !user.pfaId) {
    throw new Error("PFA portal access required");
  }
  return user;
}

async function requireAdmin(ctx: QueryCtx | MutationCtx) {
  const user = await getCurrentUser(ctx);
  if (!user) throw new Error("Not authenticated");
  if (user.role !== "admin") throw new Error("Admin access required");
  return user;
}

function normEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

// ============================================================================
// SESSION — profile of the PFA this user operates. Returns null for anyone
// who is not a linked PFA user (safe to call from shared chrome).
// endpointConfig is NEVER included (server-only credentials).
// ============================================================================

export const getSession = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user || user.role !== "pfa" || !user.pfaId) return null;
    const pfa = await ctx.db.get(user.pfaId);
    if (!pfa) return null;
    return {
      email: user.email ?? null,
      pfa: {
        _id: pfa._id,
        name: pfa.name,
        shortName: pfa.shortName ?? null,
        code: pfa.code,
        integrationMode: pfa.integrationMode,
        integrationStatus: pfa.integrationStatus ?? "not_integrated",
        integrationStatusLabel: integrationStatusLabel(pfa.integrationStatus),
        active: isSelectable(pfa),
      },
    };
  },
});

// ============================================================================
// ACCESS CLAIM — called right after sign-in. If the account's email holds an
// administrator-issued grant, activate it (role → "pfa" + pfaId link).
// Never claims for administrators, never claims without an active grant.
// ============================================================================

export const claimAccess = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return { claimed: false };
    if (user.role === "pfa" && user.pfaId) return { claimed: true };
    // An administrator exploring sign-in must never be downgraded.
    if (user.role === "admin") return { claimed: false };
    if (!user.email) return { claimed: false };

    const email = normEmail(user.email);
    const grants = await ctx.db
      .query("pfaAccessGrants")
      .withIndex("by_email", (q) => q.eq("email", email))
      .take(10_000);
    const grant = grants
      .filter((g) => g.status === "active")
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!grant) return { claimed: false };

    const pfa = await ctx.db.get(grant.pfaId);
    if (!pfa || !isSelectable(pfa)) return { claimed: false };

    await ctx.db.patch(user._id, { role: "pfa", pfaId: grant.pfaId });
    await ctx.db.patch(grant._id, { status: "claimed", claimedAt: Date.now() });
    await audit(ctx, {
      actor: email,
      action: "pfa_portal_access_claimed",
      entityType: "user",
      entityId: user._id,
      field: "role",
      before: user.role ?? "(none)",
      after: "pfa",
      details: `${email} claimed PFA portal access for ${pfa.name} (${pfa.code})`,
    });
    return { claimed: true };
  },
});

// ============================================================================
// PORTAL READS — all strictly scoped to the session user's pfaId.
// ============================================================================

async function maps(ctx: QueryCtx) {
  const [batches, employers] = await Promise.all([
    ctx.db.query("contributionBatches").take(10_000),
    ctx.db.query("employers").take(10_000),
  ]);
  return {
    batchById: new Map(batches.map((b) => [b._id, b])),
    employerById: new Map(employers.map((e) => [e._id, e])),
  };
}

/** Overview: PFA profile + portfolio statistics + recent activity. */
export const getOverview = query({
  args: {},
  handler: async (ctx) => {
    const user = await requirePfaUser(ctx);
    const pfaId = user.pfaId!;

    const [pfa, settlements, records, employees, exceptions] = await Promise.all([
      ctx.db.get(pfaId),
      ctx.db.query("settlements").withIndex("by_pfa", (q) => q.eq("pfaId", pfaId)).take(10_000),
      ctx.db.query("contributionRecords").withIndex("by_pfa", (q) => q.eq("pfaId", pfaId)).take(10_000),
      ctx.db.query("employees").withIndex("by_pfa", (q) => q.eq("pfaId", pfaId)).take(10_000),
      ctx.db.query("exceptions").withIndex("by_pfa", (q) => q.eq("pfaId", pfaId)).take(10_000),
    ]);
    if (!pfa) throw new Error("PFA record not found");

    const { batchById, employerById } = await maps(ctx);

    const settled = settlements.filter((s) => s.status === "settled");
    const pending = settlements.filter((s) => s.status === "pending" || s.status === "processing");
    const failed = settlements.filter((s) => s.status === "failed");
    const openExceptions = exceptions.filter((e) => e.status === "open");

    const recentSettlements = settlements
      .sort((a, b) => b.instructedAt - a.instructedAt)
      .slice(0, 8)
      .map((s) => {
        const batch = batchById.get(s.batchId);
        const employer = batch ? employerById.get(batch.employerId) : null;
        return {
          settlementId: s._id,
          settlementRef: s.settlementRef,
          amount: s.amount,
          employeeCount: s.employeeCount,
          status: s.status,
          instructedAt: s.instructedAt,
          batchRef: batch?.batchRef ?? "—",
          pfaStatus: batch?.pfaStatus ?? null,
          employerName: employer?.name ?? "Unknown employer",
        };
      });

    return {
      pfa: {
        _id: pfa._id,
        name: pfa.name,
        shortName: pfa.shortName ?? null,
        code: pfa.code,
        integrationMode: pfa.integrationMode,
        integrationStatus: pfa.integrationStatus ?? "not_integrated",
        integrationStatusLabel: integrationStatusLabel(pfa.integrationStatus),
        active: isSelectable(pfa),
      },
      stats: {
        totalContributions: records.reduce((s, r) => s + r.totalAmount, 0),
        employeeContributions: records.reduce((s, r) => s + r.employeeContribution, 0),
        employerContributions: records.reduce((s, r) => s + r.employerContribution, 0),
        recordCount: records.length,
        settledAmount: settled.reduce((s, x) => s + x.amount, 0),
        settledCount: settled.length,
        pendingAmount: pending.reduce((s, x) => s + x.amount, 0),
        pendingCount: pending.length,
        failedAmount: failed.reduce((s, x) => s + x.amount, 0),
        failedCount: failed.length,
        memberCount: employees.length,
        employerCount: new Set(employees.map((e) => String(e.employerId))).size,
        openExceptions: openExceptions.length,
      },
      recentSettlements,
      openExceptions: openExceptions
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 5)
        .map((e) => ({
          _id: e._id,
          exceptionRef: e.exceptionRef,
          type: e.type,
          description: e.description,
          amount: e.amount ?? null,
          status: e.status,
          responsibleParty: e.responsibleParty,
          createdAt: e.createdAt,
        })),
    };
  },
});

/** Settlement instructions addressed to this PFA (incoming remittances). */
export const listSettlements = query({
  args: {},
  handler: async (ctx) => {
    const user = await requirePfaUser(ctx);
    const pfaId = user.pfaId!;
    const settlements = await ctx.db
      .query("settlements")
      .withIndex("by_pfa", (q) => q.eq("pfaId", pfaId))
      .take(10_000);
    const { batchById, employerById } = await maps(ctx);

    const rows = await Promise.all(
      settlements.map(async (s) => {
        const batch = batchById.get(s.batchId);
        const employer = batch ? employerById.get(batch.employerId) : null;
        const ack = await ctx.db
          .query("pfaAcknowledgements")
          .withIndex("by_settlement", (q) => q.eq("settlementId", s._id))
          .order("desc")
          .first();
        return {
          _id: s._id,
          settlementRef: s.settlementRef,
          amount: s.amount,
          employeeCount: s.employeeCount,
          status: s.status,
          instructedAt: s.instructedAt,
          confirmedAt: s.confirmedAt ?? null,
          failureReason: s.failureReason ?? null,
          batchRef: batch?.batchRef ?? "—",
          period: batch
            ? `${batch.contributionYear}-${String(batch.contributionMonth).padStart(2, "0")}`
            : "—",
          batchPfaStatus: batch?.pfaStatus ?? null,
          employerName: employer?.name ?? "Unknown employer",
          ackStatus: ack?.status ?? null,
          ackAt: ack?.receivedAt ?? null,
        };
      }),
    );
    return rows.sort((a, b) => b.instructedAt - a.instructedAt).slice(0, 300);
  },
});

/** Contribution records allocated to this PFA. */
export const listContributions = query({
  args: {},
  handler: async (ctx) => {
    const user = await requirePfaUser(ctx);
    const pfaId = user.pfaId!;
    const records = await ctx.db
      .query("contributionRecords")
      .withIndex("by_pfa", (q) => q.eq("pfaId", pfaId))
      .take(10_000);
    const { batchById, employerById } = await maps(ctx);

    return records
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 500)
      .map((r) => {
        const batch = batchById.get(r.batchId);
        const employer = employerById.get(r.employerId);
        return {
          _id: r._id,
          recordRef: r.recordRef,
          fullName: r.fullName,
          pensionPin: r.pensionPin,
          employeeCode: r.employeeCode,
          employerName: employer?.name ?? "Unknown employer",
          batchRef: batch?.batchRef ?? "—",
          period: `${r.contributionYear}-${String(r.contributionMonth).padStart(2, "0")}`,
          employeeContribution: r.employeeContribution,
          employerContribution: r.employerContribution,
          totalAmount: r.totalAmount,
          validationStatus: r.validationStatus,
          allocationStatus: r.allocationStatus,
          settlementStatus: r.settlementStatus,
          pfaStatus: r.pfaStatus,
          createdAt: r.createdAt,
        };
      });
  },
});

/** Members (employees) whose RSA accounts are held with this PFA. */
export const listEmployees = query({
  args: {},
  handler: async (ctx) => {
    const user = await requirePfaUser(ctx);
    const pfaId = user.pfaId!;
    const employees = await ctx.db
      .query("employees")
      .withIndex("by_pfa", (q) => q.eq("pfaId", pfaId))
      .take(10_000);
    const employers = await ctx.db.query("employers").take(10_000);
    const employerById = new Map(employers.map((e) => [e._id, e]));

    return employees
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
      .map((e) => ({
        _id: e._id,
        fullName: e.fullName,
        pensionPin: e.pensionPin,
        employeeCode: e.employeeCode,
        active: e.active,
        employerName: employerById.get(e.employerId)?.name ?? "Unknown employer",
        createdAt: e.createdAt,
      }));
  },
});

/** Employers remitting to this PFA (derived only from this PFA's own rows). */
export const listEmployers = query({
  args: {},
  handler: async (ctx) => {
    const user = await requirePfaUser(ctx);
    const pfaId = user.pfaId!;
    const [employees, records, employers] = await Promise.all([
      ctx.db.query("employees").withIndex("by_pfa", (q) => q.eq("pfaId", pfaId)).take(10_000),
      ctx.db.query("contributionRecords").withIndex("by_pfa", (q) => q.eq("pfaId", pfaId)).take(10_000),
      ctx.db.query("employers").take(10_000),
    ]);
    const employerById = new Map(employers.map((e) => [e._id, e]));

    type Row = {
      employerId: string;
      name: string;
      rcNumber: string;
      status: string;
      memberCount: number;
      contributionTotal: number;
      recordCount: number;
      lastActivity: number;
    };
    const rows = new Map<string, Row>();
    for (const e of employees) {
      const emp = employerById.get(e.employerId);
      if (!emp) continue;
      const row =
        rows.get(String(e.employerId)) ??
        ({
          employerId: String(e.employerId),
          name: emp.name,
          rcNumber: emp.rcNumber,
          status: emp.status,
          memberCount: 0,
          contributionTotal: 0,
          recordCount: 0,
          lastActivity: 0,
        } satisfies Row);
      row.memberCount++;
      rows.set(row.employerId, row);
    }
    for (const r of records) {
      const row = rows.get(String(r.employerId));
      if (!row) continue;
      row.contributionTotal += r.totalAmount;
      row.recordCount++;
      row.lastActivity = Math.max(row.lastActivity, r.createdAt);
    }
    return [...rows.values()].sort((a, b) => b.contributionTotal - a.contributionTotal);
  },
});

/** Exceptions attributed to this PFA. */
export const listExceptions = query({
  args: {},
  handler: async (ctx) => {
    const user = await requirePfaUser(ctx);
    const pfaId = user.pfaId!;
    const exceptions = await ctx.db
      .query("exceptions")
      .withIndex("by_pfa", (q) => q.eq("pfaId", pfaId))
      .take(10_000);
    const employers = await ctx.db.query("employers").take(10_000);
    const employerById = new Map(employers.map((e) => [e._id, e]));

    return exceptions
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 200)
      .map((e) => ({
        _id: e._id,
        exceptionRef: e.exceptionRef,
        type: e.type,
        description: e.description,
        amount: e.amount ?? null,
        status: e.status,
        responsibleParty: e.responsibleParty,
        resolutionNotes: e.resolutionNotes ?? null,
        employerName: e.employerId ? employerById.get(e.employerId)?.name ?? "—" : "—",
        createdAt: e.createdAt,
        resolvedAt: e.resolvedAt ?? null,
      }));
  },
});

// ============================================================================
// ADMINISTRATION — provisioning and revocation of PFA portal access.
// Every change is audited.
// ============================================================================

/** All PFA portal access: linked accounts + outstanding grants. */
export const adminListAccess = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const [grants, users, pfas] = await Promise.all([
      ctx.db.query("pfaAccessGrants").take(10_000),
      ctx.db.query("users").take(10_000),
      ctx.db.query("pfas").collect(),
    ]);
    const pfaById = new Map(pfas.map((p) => [p._id, p]));

    const linked = users
      .filter((u) => u.role === "pfa" && u.pfaId)
      .map((u) => ({
        userId: u._id,
        email: u.email ?? "(no email)",
        pfaId: u.pfaId!,
        pfaName: pfaById.get(u.pfaId!)?.name ?? "Unknown PFA",
        createdAt: 0,
      }))
      .sort((a, b) => a.email.localeCompare(b.email));

    const grantRows = grants
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((g) => ({
        grantId: g._id,
        email: g.email,
        pfaId: g.pfaId,
        pfaName: pfaById.get(g.pfaId)?.name ?? "Unknown PFA",
        status: g.status,
        grantedBy: g.grantedBy,
        createdAt: g.createdAt,
        claimedAt: g.claimedAt ?? null,
      }));

    return { linked, grants: grantRows };
  },
});

/**
 * Grant (or re-grant) PFA portal access to an email address for one PFA.
 * If the email already has a Penroute account it is linked immediately;
 * otherwise an invitation is stored and claimed on first sign-in.
 */
export const adminProvisionAccess = mutation({
  args: { email: v.string(), pfaId: v.id("pfas") },
  handler: async (ctx, { email, pfaId }) => {
    const admin = await requireAdmin(ctx);
    const normalized = normEmail(email);
    if (!validEmail(normalized)) throw new Error("Enter a valid email address");
    const pfa = await ctx.db.get(pfaId);
    if (!pfa) throw new Error("PFA not found");
    if (!isSelectable(pfa)) throw new Error("Cannot grant access to an inactive PFA");

    const users = await ctx.db.query("users").take(10_000);
    const existing = users.find((u) => u.email && normEmail(u.email) === normalized);

    if (existing) {
      if (existing.role === "admin") {
        throw new Error("Refusing to change an administrator account");
      }
      if (existing.role === "pfa" && existing.pfaId === pfaId) {
        return { provisioned: "unchanged" as const };
      }
      const before = `${existing.role ?? "(none)"}${existing.pfaId ? " → other PFA" : ""}`;
      await ctx.db.patch(existing._id, { role: "pfa", pfaId });
      // Supersede any outstanding grants for this address.
      const grants = await ctx.db
        .query("pfaAccessGrants")
        .withIndex("by_email", (q) => q.eq("email", normalized))
        .take(10_000);
      for (const g of grants) {
        if (g.status === "active") await ctx.db.patch(g._id, { status: "claimed", claimedAt: Date.now() });
      }
      await audit(ctx, {
        actor: admin.email ?? "admin",
        action: "pfa_portal_access_granted",
        entityType: "user",
        entityId: existing._id,
        field: "role",
        before,
        after: `pfa → ${pfa.name} (${pfa.code})`,
        details: `PFA portal access linked: ${normalized} → ${pfa.name}`,
      });
      return { provisioned: "linked" as const };
    }

    // No account yet — store an invitation claimed on first sign-in.
    const grants = await ctx.db
      .query("pfaAccessGrants")
      .withIndex("by_email", (q) => q.eq("email", normalized))
      .take(10_000);
    const open = grants.find((g) => g.status === "active" || g.status === "claimed");
    if (open && open.pfaId === pfaId && open.status !== "revoked") {
      return { provisioned: "unchanged" as const };
    }
    const revoked = grants.find((g) => g.status === "revoked");
    if (revoked) {
      await ctx.db.patch(revoked._id, {
        pfaId,
        status: "active",
        revokedAt: undefined,
        createdAt: Date.now(),
        grantedBy: admin.email ?? "admin",
      });
    } else {
      await ctx.db.insert("pfaAccessGrants", {
        email: normalized,
        pfaId,
        status: "active",
        grantedBy: admin.email ?? "admin",
        createdAt: Date.now(),
      });
    }
    await audit(ctx, {
      actor: admin.email ?? "admin",
      action: "pfa_portal_access_invited",
      entityType: "pfa",
      entityId: pfaId,
      after: normalized,
      details: `PFA portal invitation created: ${normalized} → ${pfa.name} (activates on first sign-in)`,
    });
    return { provisioned: "invited" as const };
  },
});

/** Revoke an unclaimed/outstanding invitation. */
export const adminRevokeGrant = mutation({
  args: { grantId: v.id("pfaAccessGrants") },
  handler: async (ctx, { grantId }) => {
    const admin = await requireAdmin(ctx);
    const grant = await ctx.db.get(grantId);
    if (!grant) throw new Error("Grant not found");
    if (grant.status === "revoked") return { ok: true, unchanged: true };
    await ctx.db.patch(grantId, { status: "revoked", revokedAt: Date.now() });
    await audit(ctx, {
      actor: admin.email ?? "admin",
      action: "pfa_portal_access_revoked",
      entityType: "pfa",
      entityId: grant.pfaId,
      field: "status",
      before: grant.status,
      after: "revoked",
      details: `PFA portal invitation revoked: ${grant.email}`,
    });
    return { ok: true };
  },
});

/** Remove an existing user's PFA portal access (and any live invitation). */
export const adminUnlinkPfaUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const admin = await requireAdmin(ctx);
    const target = await ctx.db.get(userId);
    if (!target) throw new Error("User not found");
    if (target.role === "admin") throw new Error("Refusing to change an administrator account");
    if (target.role !== "pfa") return { ok: true, unchanged: true };

    await ctx.db.patch(userId, { role: "user", pfaId: undefined });
    if (target.email) {
      const email = normEmail(target.email);
      const grants = await ctx.db
        .query("pfaAccessGrants")
        .withIndex("by_email", (q) => q.eq("email", email))
        .take(10_000);
      for (const g of grants) {
        if (g.status !== "revoked") await ctx.db.patch(g._id, { status: "revoked", revokedAt: Date.now() });
      }
    }
    await audit(ctx, {
      actor: admin.email ?? "admin",
      action: "pfa_portal_access_unlinked",
      entityType: "user",
      entityId: userId,
      field: "role",
      before: "pfa",
      after: "user",
      details: `PFA portal access removed: ${target.email ?? userId}`,
    });
    return { ok: true };
  },
});
