import { Email } from "@convex-dev/auth/providers/Email";
import axios from "axios";
import { RandomReader, generateRandomString } from "@oslojs/crypto/random";

export const emailOtp = Email({
  id: "email-otp",
  maxAge: 60 * 15, // 15 minutes
  // This function can be asynchronous
  async generateVerificationToken() {
    const random: RandomReader = {
      read(bytes: Uint8Array) {
        crypto.getRandomValues(bytes);
      },
    };
    const alphabet = "0123456789";
    return generateRandomString(random, alphabet, 6);
  },
  async sendVerificationRequest({ identifier: email, token }) {
    // Preferred: Penroute's own email provider (Resend) — no Freebuff
    // dependency. Fallback: the Freebuff OTP relay, only if its key is set.
    // Keys are SECRETS read from the deployment environment, never code.
    const resendKey = process.env.RESEND_API_KEY;
    const from = process.env.NOTIFY_FROM_EMAIL;
    if (resendKey && from) {
      try {
        const res = await axios.post(
          "https://api.resend.com/emails",
          {
            from,
            to: [email],
            subject: `Your Penroute sign-in code: ${token}`,
            text: `Your Penroute sign-in code is ${token}. It expires in 15 minutes. If you did not request it, ignore this email.`,
            html: `<div style="font-family:Arial,sans-serif;color:#0B1F2A"><p>Your Penroute sign-in code is</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#007A4D">${token}</p><p style="color:#5A6B74;font-size:13px">It expires in 15 minutes. If you did not request it, ignore this email.</p></div>`,
          },
          { headers: { Authorization: `Bearer ${resendKey}` }, timeout: 15_000 },
        );
        if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
        return;
      } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        console.error(`Sign-in email failed${status ? ` (HTTP ${status})` : ""}`);
        throw new Error("We couldn't send your sign-in code. Please try again shortly.");
      }
    }

    const apiKey = process.env.EMAIL_OTP_API_KEY;
    if (!apiKey) {
      console.error("No email provider configured (set RESEND_API_KEY + NOTIFY_FROM_EMAIL)");
      throw new Error("Sign-in emails are temporarily unavailable. Please try again later.");
    }
    try {
      await axios.post(
        "https://auth.freebuff.app/send_otp",
        { to: email, otp: token, appName: process.env.VLY_APP_NAME || "Penroute" },
        { headers: { "x-api-key": apiKey }, timeout: 15_000 },
      );
    } catch (error) {
      // Never serialise the axios error: it contains the request headers,
      // i.e. the relay API key, and would leak it into logs/clients.
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      console.error(`OTP relay request failed${status ? ` (HTTP ${status})` : ""}`);
      throw new Error("We couldn't send your sign-in code. Please try again shortly.");
    }
  },
});
