import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { paystackWebhook } from "./paystackWebhook";
import { payrollScheduleIntake } from "./payrollApi";

const http = httpRouter();

auth.addHttpRoutes(http);

// Employer payroll/HR integration (spec §4): push the monthly pension
// schedule server-to-server with the employer's API key (generated in
// Settings → Payroll Integration).
http.route({
  path: "/api/v1/schedules",
  method: "POST",
  handler: payrollScheduleIntake,
});

// Production payment confirmation path: Paystack calls this when a payment
// succeeds/fails — works even when the employer's browser is closed.
// Signature-verified (HMAC-SHA512 with the secret key) in paystackWebhook.ts.
http.route({
  path: "/webhooks/paystack",
  method: "POST",
  handler: paystackWebhook,
});

export default http;
