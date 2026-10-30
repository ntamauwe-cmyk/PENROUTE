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
    // The relay key is a SECRET: it must come from the deployment environment
    // (EMAIL_OTP_API_KEY). It is never hard-coded — a key committed to a
    // public repository lets anyone send sign-in emails in Penroute's name.
    const apiKey = process.env.EMAIL_OTP_API_KEY;
    if (!apiKey) {
      console.error("EMAIL_OTP_API_KEY is not configured — cannot send sign-in codes");
      throw new Error("Sign-in emails are temporarily unavailable. Please try again later.");
    }
    try {
      await axios.post(
        "https://auth.freebuff.app/send_otp",
        {
          to: email,
          otp: token,
          appName: process.env.VLY_APP_NAME || "Penroute",
        },
        {
          headers: {
            "x-api-key": apiKey,
          },
          timeout: 15_000,
        },
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
