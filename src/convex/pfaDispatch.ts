/**
 * ============================================================================
 * LIVE PFA DISPATCH ENGINE (spec §11, §13, §38)
 * ============================================================================
 * Delivers queued settlement instructions to PFAs configured as "live_api"
 * with an approved HTTPS endpoint — the production handoff:
 * Platform → PFA infrastructure → employee RSA.
 *
 * PFA live endpoint contract (documented, configurable):
 *   POST <endpoint>
 *   Headers:
 *     Content-Type: application/json
 *     Authorization: Bearer <apiSecret>        (or X-API-Key if headerName set)
 *     X-Penroute-Signature: sha256=<hmac>      (shared secret, if configured)
 *     X-Penroute-Settlement: <settlementRef>
 *   Body: { settlementRef, batchRef, contributionMonth, contributionYear,
 *           employer: { name, rcNumber }, employees: [...] }
 *
 * The PFA responds:
 *   { status: "received" | "accepted" | "rejected" | "partially_accepted"
 *           | "processing" | "posted" | "failed" | "reconciled",
 *     message?, acceptedCount?, rejectedCount? }
 *
 * Runs in Node ("use node") for outbound HTTPS. PFA credentials NEVER reach
 * the browser — data access lives in pfaDispatchData.ts (internal functions).
 * An unconfigured PFA → nothing dispatches; instructions stay pending and
 * visible as "Awaiting PFA integration" — never falsely "posted".
 * ============================================================================
 */
"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createHmac } from "node:crypto";

/** Statuses a PFA system may return (spec §13). */
const PFA_STATUSES = new Set([
  "received",
  "accepted",
  "rejected",
  "partially_accepted",
  "processing",
  "posted",
  "failed",
  "reconciled",
]);

/** Reject obvious SSRF targets before server-side outbound requests. */
function isSafePublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal") return false;
    if (host.includes(":")) return false;
    const octets = host.split(".").map(Number);
    if (octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      const [a, b] = octets;
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
    } else if (!host.includes(".")) return false;
    return true;
  } catch { return false; }
}

interface PfaEndpointConfig {
  endpoint?: string;
  apiSecret?: string;
  secretHeaderName?: string;
  hmacSecret?: string;
}

interface DispatchOutcome {
  settlementId: string;
  settlementRef: string;
  ok: boolean;
  status?: string;
  message?: string;
  acceptedCount?: number;
  rejectedCount?: number;
  httpStatus?: number;
  reason?: string;
}

function authHeaders(cfg: PfaEndpointConfig, settlementRef?: string, body?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settlementRef) headers["X-Penroute-Settlement"] = settlementRef;
  if (cfg.apiSecret) {
    const headerName = cfg.secretHeaderName || "Authorization";
    headers[headerName] =
      headerName === "Authorization" ? `Bearer ${cfg.apiSecret}` : cfg.apiSecret;
  }
  if (cfg.hmacSecret && body) {
    headers["X-Penroute-Signature"] =
      `sha256=${createHmac("sha256", cfg.hmacSecret).update(body).digest("hex")}`;
  }
  return headers;
}

/** Deliver every pending settlement instruction for a batch to live PFAs. */
export const dispatchLiveSettlements = internalAction({
  args: { batchId: v.id("contributionBatches") },
  handler: async (ctx, { batchId }) => {
    const settlements: Array<{ _id: Id<"settlements">; settlementRef: string; pfaId: Id<"pfas"> }> =
      await ctx.runQuery(internal.pfaDispatchData.internalPendings, { batchId });
    if (settlements.length === 0) return { dispatched: 0, results: [] as DispatchOutcome[] };

    const meta: {
      batchRef: string;
      contributionMonth: number;
      contributionYear: number;
      employerName: string;
      employerRc: string;
    } | null = await ctx.runQuery(internal.pfaDispatchData.internalBatchMeta, { batchId });
    const results: DispatchOutcome[] = [];

    for (const s of settlements) {
      const pfa: { _id: Id<"pfas">; name: string; code: string; endpointConfig?: PfaEndpointConfig } | null =
        await ctx.runQuery(internal.pfaDispatchData.internalPfaFor, {
          settlementId: s._id,
        });
      if (!pfa) {
        await ctx.runMutation(internal.pfaDispatchData.internalRecord, {
          settlementId: s._id,
          ok: false,
          failureReason: "PFA record missing",
        });
        results.push({ settlementId: s._id, settlementRef: s.settlementRef, ok: false, reason: "PFA record missing" });
        continue;
      }
      const cfg = (pfa.endpointConfig ?? {}) as PfaEndpointConfig;
      if (!cfg.endpoint || !isSafePublicHttpsUrl(cfg.endpoint)) {
        // Not configured — stays pending and visible, never silently posted.
        await ctx.runMutation(internal.pfaDispatchData.internalLog, {
          settlementId: s._id,
          ok: false,
          summary: `no approved endpoint configured for ${pfa.name} — instruction remains pending`,
        });
        results.push({
          settlementId: s._id,
          settlementRef: s.settlementRef,
          ok: false,
          reason: `${pfa.name}: no approved endpoint configured`,
        });
        continue;
      }

      // Build the contribution file for this settlement.
      const records: Array<{
        employeeCode: string;
        fullName: string;
        pensionPin: string;
        employeeContribution: number;
        employerContribution: number;
        totalAmount: number;
      }> = await ctx.runQuery(internal.pfaDispatchData.internalRecords, {
        batchId,
        pfaId: s.pfaId,
      });
      const body = JSON.stringify({
        settlementRef: s.settlementRef,
        batchRef: meta?.batchRef,
        contributionMonth: meta?.contributionMonth,
        contributionYear: meta?.contributionYear,
        employer: { name: meta?.employerName, rcNumber: meta?.employerRc },
        employees: records.map((r) => ({
          employeeCode: r.employeeCode,
          fullName: r.fullName,
          pensionPin: r.pensionPin,
          employeeContributionKobo: r.employeeContribution,
          employerContributionKobo: r.employerContribution,
          totalKobo: r.totalAmount,
        })),
      });

      let outcome: DispatchOutcome;
      try {
        const res = await fetch(cfg.endpoint, {
          method: "POST",
          headers: authHeaders(cfg, s.settlementRef, body),
          body,
          signal: AbortSignal.timeout(10_000),
        });
        const text = await res.text();
        let parsed: { status?: string; message?: string; acceptedCount?: number; rejectedCount?: number } = {};
        try {
          parsed = JSON.parse(text) as typeof parsed;
        } catch {
          parsed = {};
        }
        const status =
          parsed.status && PFA_STATUSES.has(parsed.status) ? parsed.status : res.ok ? "received" : "failed";
        outcome = {
          settlementId: s._id,
          settlementRef: s.settlementRef,
          ok: res.ok && status !== "failed",
          status,
          message: parsed.message ?? text.slice(0, 300),
          acceptedCount: parsed.acceptedCount,
          rejectedCount: parsed.rejectedCount,
          httpStatus: res.status,
        };
      } catch (e) {
        outcome = {
          settlementId: s._id,
          settlementRef: s.settlementRef,
          ok: false,
          reason: e instanceof Error ? e.message : "Network failure delivering to PFA",
        };
      }

      // Record the real PFA response (idempotent mutation + audit + logs).
      await ctx.runMutation(internal.pfaDispatchData.internalRecord, {
        settlementId: s._id,
        ok: outcome.ok,
        status: outcome.status,
        message: outcome.message,
        acceptedCount: outcome.acceptedCount,
        rejectedCount: outcome.rejectedCount,
        failureReason: outcome.reason,
        httpStatus: outcome.httpStatus,
      });
      results.push(outcome);
    }
    return { dispatched: settlements.length, results };
  },
});

/** Admin/system: verify a PFA endpoint responds before trusting dispatch. */
export const testPfaConnection = action({
  args: { pfaId: v.id("pfas") },
  handler: async (
    ctx,
    { pfaId },
  ): Promise<
    | { ok: false; reason: string }
    | { ok: boolean; httpStatus: number; response: string }
  > => {
    const caller = await ctx.runQuery(api.users.currentUser, {});
    if (!caller || caller.role !== "admin") {
      throw new Error("Admin access required");
    }
    const pfa: { name: string; code: string; endpointConfig?: PfaEndpointConfig } | null =
      await ctx.runQuery(internal.pfaDispatchData.internalPfaById, { pfaId });
    if (!pfa) return { ok: false as const, reason: "PFA not found" };
    const cfg = (pfa.endpointConfig ?? {}) as PfaEndpointConfig;
    if (!cfg.endpoint || !isSafePublicHttpsUrl(cfg.endpoint)) return { ok: false as const, reason: "PFA endpoint must be a valid public HTTPS URL on port 443" };
    try {
      const res = await fetch(cfg.endpoint, {
        method: "POST",
        headers: authHeaders(cfg),
        body: JSON.stringify({ ping: true, pfaCode: pfa.code, timestamp: Date.now() }),
        signal: AbortSignal.timeout(10_000),
      });
      const text = (await res.text()).slice(0, 200);
      return { ok: res.ok as boolean, httpStatus: res.status, response: text };
    } catch (e) {
      return { ok: false as const, reason: e instanceof Error ? e.message : "Connection failed" };
    }
  },
});
