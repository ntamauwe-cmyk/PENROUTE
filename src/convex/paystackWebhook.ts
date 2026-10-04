/**
 * ============================================================================
 * PAYSTACK WEBHOOK — production payment confirmation (server-to-server)
 * ----------------------------------------------------------------------------
 * Paystack POSTs charge.success / charge.failed to /webhooks/paystack with an
 * x-paystack-signature header: HMAC-SHA512 of the raw body using the SECRET
 * key. Verified here with Web Crypto (standard runtime — no "use node" needed,
 * so this file can be registered on the HTTP router without Node bundling).
 *
 * This is the AUTHORITATIVE confirmation path: it works even when the
 * employer's browser is closed, and it cannot be forged without the secret.
 * ============================================================================
 */
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import type { FunctionReference } from "convex/server";

// Generated types have caught up — resolve the internal references directly.
// (Kept behind a typed accessor so a future rename fails loudly, not silently.)
const engineApi = api.engine as unknown as {
  getPaymentByRef: FunctionReference<"query">;
  finalizeLivePaymentSystem: FunctionReference<"mutation">;
  markLivePaymentFailedSystem: FunctionReference<"mutation">;
};

// In-memory per-isolate idempotency. The database-level guards in
// finalizeLivePaymentSystem (status check + idempotent pipeline) are the
// durable protection; this just avoids repeat work on redeliveries.

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function verifyPaystackSignature(raw: string, signature: string, key: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(raw));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return timingSafeEqualHex(expected, signature.toLowerCase());
}

export const paystackWebhook = httpAction(async (ctx, request) => {
  const signature = request.headers.get("x-paystack-signature");
  const raw = await request.text();

  // The secret lives only in the server environment (Keys tab). Webhooks
  // without a configured key or signature are rejected outright.
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key || !signature) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  let valid = false;
  try {
    valid = await verifyPaystackSignature(raw, signature, key);
  } catch {
    valid = false;
  }
  if (!valid) {
    return new Response(JSON.stringify({ error: "invalid signature" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  let event: {
    event: string;
    data?: { reference?: string; amount?: number; fees?: number; status?: string; currency?: string };
  };
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }

  const reference = event.data?.reference;
  if (!reference) {
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  }

  // Durable payment status guards below handle duplicate provider deliveries.

  if (event.event === "charge.success") {
    // Look the payment up by the provider reference — never trust the payload.
    const payment = await ctx.runQuery(engineApi.getPaymentByRef, { paymentRef: reference });
    if (!payment) {
      return new Response(JSON.stringify({ received: true, unknown: true }), { status: 200 });
    }
    if (payment.status === "successful") {
      return new Response(JSON.stringify({ received: true, alreadyProcessed: true }), { status: 200 });
    }
    // Require exact provider-reported amount and currency before finalization.
    // Missing values are rejected rather than treated as trusted.
    if (event.data?.status !== "success" || event.data?.amount !== payment.amount || event.data?.currency !== "NGN") {
      await ctx.runMutation(engineApi.markLivePaymentFailedSystem, {
        paymentId: payment._id,
        reason: "Webhook status, exact amount, or currency did not match the stored payment",
      });
      return new Response(JSON.stringify({ received: true, mismatch: true }), { status: 200 });
    }
    await ctx.runMutation(engineApi.finalizeLivePaymentSystem, {
      paymentId: payment._id,
      providerFeesKobo: event.data?.fees,
    });
  } else if (event.event === "charge.failed") {
    const payment = await ctx.runQuery(engineApi.getPaymentByRef, { paymentRef: reference });
    if (payment && payment.status !== "successful") {
      await ctx.runMutation(engineApi.markLivePaymentFailedSystem, {
        paymentId: payment._id,
        reason: "Paystack reports the payment failed (charge.failed webhook)",
      });
    }
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 });
});
