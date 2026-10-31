/**
 * APPROVED-PROVIDER WEBHOOK — the provider tells Penroute a remittance was
 * paid (or failed). POST /webhooks/remittance-partner
 *
 *   Header: X-Penroute-Signature: sha256=<hex HMAC-SHA256 of the raw body,
 *           keyed with the webhook secret agreed with the provider>
 *   Body:   { "paymentRef": "PMT-…", "status": "paid" | "failed",
 *             "amountKobo": 12345600, "partnerRef": "…", "reason"?: "…" }
 *
 * Unsigned or wrongly signed calls are refused. A "paid" confirmation is
 * applied only when the amount matches the schedule exactly; anything else
 * becomes an exception for an administrator. Idempotent.
 */
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { readCapped } from "../lib/security";

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function hmacSha256Hex(raw: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(raw));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const partnerWebhook = httpAction(async (ctx, request) => {
  let raw: string;
  try {
    raw = await readCapped(request.body, 200_000);
  } catch {
    return json({ error: "payload too large" }, 413);
  }
  const secret = await ctx.runQuery(internal.remittancePartner.getWebhookSecret, {});
  const header = (request.headers.get("x-penroute-signature") ?? "").trim();
  const sig = header.startsWith("sha256=") ? header.slice(7).toLowerCase() : "";
  if (!secret || !sig) return json({ error: "unauthorized" }, 401);
  const expected = await hmacSha256Hex(raw, secret);
  if (!timingSafeEqualHex(expected, sig)) return json({ error: "invalid signature" }, 401);

  let body: { paymentRef?: unknown; status?: unknown; amountKobo?: unknown; partnerRef?: unknown; reason?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (
    typeof body.paymentRef !== "string" ||
    (body.status !== "paid" && body.status !== "failed") ||
    typeof body.amountKobo !== "number" ||
    !Number.isInteger(body.amountKobo)
  ) {
    return json({ error: "paymentRef, status (paid|failed) and integer amountKobo are required" }, 400);
  }
  const res = await ctx.runMutation(internal.remittancePartner.webhookConfirm, {
    paymentRef: body.paymentRef.slice(0, 64),
    status: body.status,
    amountKobo: body.amountKobo,
    partnerRef: typeof body.partnerRef === "string" ? body.partnerRef.slice(0, 80) : undefined,
    reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : undefined,
  });
  return json({ received: true, ...res }, 200);
});
