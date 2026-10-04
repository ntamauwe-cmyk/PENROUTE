/**
 * ============================================================================
 * EMPLOYER PAYROLL/HR API (spec §4) — schedule intake over HTTPS
 * ----------------------------------------------------------------------------
 * Employers connect their payroll/HR system by generating an API key in
 * Settings → Payroll Integration and pushing the monthly pension schedule:
 *
 *   POST /api/v1/schedules
 *   Authorization: Bearer penr_live_xxxx…
 *   Content-Type: application/json
 *   {
 *     "contributionYear": 2026,
 *     "contributionMonth": 9,
 *     "records": [
 *       { "fullName": "Adaeze Okafor", "employeeCode": "RAE-EMP-001",
 *         "pensionPin": "PIN100000", "pfaCode": "001",
 *         "employeeContribution": 25000, "employerContribution": 25000 }
 *     ]
 *   }
 *
 * Responses (always JSON):
 *   200 { ok, batchRef, duplicate, validCount, invalidCount }  ← intake accepted
 *   401 { ok: false, error }  ← missing/invalid API key
 *   403 { ok: false, error }  ← employer suspended
 *   400 { ok: false, error }  ← validation failure (month, empty schedule…)
 *   405                        ← wrong method
 *
 * Intake reuses the exact same idempotent core as the browser wizard
 * (engine.createBatchCore): duplicate submissions return the existing batch
 * instead of creating a second one. Payment is NOT taken through this
 * endpoint — the employer authorises the consolidated payment in the app
 * (or it sits as awaiting_payment), which keeps money movement behind the
 * authenticated, audited UI flow.
 * ============================================================================
 */
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { readCapped } from "../lib/security";

export const payrollScheduleIntake = httpAction(async (ctx, request) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }

  const auth = request.headers.get("authorization") ?? "";
  const apiKey = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!apiKey) {
    return new Response(JSON.stringify({ ok: false, error: "Missing Authorization: Bearer <api key>" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  let body: {
    contributionYear?: number;
    contributionMonth?: number;
    records?: unknown;
  };
  try {
    // Request-size limit: a hostile client cannot stream an unbounded body
    // into the runtime (2 MB — comfortably above a 10k-row schedule).
    body = JSON.parse(await readCapped(request.body, 2_000_000));
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: "Invalid JSON body or payload exceeds 2 MB" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const year = Number(body.contributionYear);
  const month = Number(body.contributionMonth);
  const records = Array.isArray(body.records) ? body.records : null;

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return new Response(JSON.stringify({ ok: false, error: "contributionYear must be a valid year" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return new Response(JSON.stringify({ ok: false, error: "contributionMonth must be 1..12" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (!records) {
    return new Response(JSON.stringify({ ok: false, error: "records must be an array" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (records.length > 10_000) {
    return new Response(
      JSON.stringify({ ok: false, error: "records exceeds the 10,000 row limit" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  // Normalise + validate row shape before touching the database.
  const cleanRecords: {
    fullName: string;
    employeeCode: string;
    pensionPin: string;
    pfaCode: string;
    employeeContribution: number;
    employerContribution: number;
  }[] = [];
  for (const raw of records) {
    const r = raw as Record<string, unknown>;
    const fullName = typeof r.fullName === "string" ? r.fullName.trim() : "";
    const employeeCode = typeof r.employeeCode === "string" ? r.employeeCode.trim() : "";
    const pensionPin = typeof r.pensionPin === "string" ? r.pensionPin.trim() : "";
    const pfaCode = typeof r.pfaCode === "string" ? r.pfaCode.trim() : "";
    const employeeContribution = Number(r.employeeContribution);
    const employerContribution = Number(r.employerContribution);
    if (
      !fullName ||
      !employeeCode ||
      !pensionPin ||
      !pfaCode ||
      !Number.isFinite(employeeContribution) ||
      !Number.isFinite(employerContribution) ||
      employeeContribution < 0 ||
      employerContribution < 0
    ) {
      return new Response(
        JSON.stringify({
          ok: false,
          error:
            "Each record requires fullName, employeeCode, pensionPin, pfaCode, employeeContribution ≥ 0 and employerContribution ≥ 0 (naira)",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    cleanRecords.push({
      fullName,
      employeeCode,
      pensionPin,
      pfaCode,
      employeeContribution,
      employerContribution,
    });
  }

  // The secret key never leaves the server: authentication + intake happen in
  // one internal mutation (engine.intakeApiSchedule).
  const result = await ctx.runMutation(internal.engine.intakeApiSchedule, {
    apiKey,
    year,
    month,
    records: cleanRecords,
  });

  if (!result.ok) {
    return new Response(JSON.stringify({ ok: false, error: result.error }), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      batchRef: result.batchRef,
      duplicate: result.duplicate,
      validCount: result.validCount,
      invalidCount: result.invalidCount,
      nextStep:
        "The schedule is stored and awaiting payment. Authorise the consolidated payment in the Penroute dashboard.",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
});
