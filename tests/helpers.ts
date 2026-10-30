/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import schema from "../src/convex/schema";
import { internal } from "../src/convex/_generated/api";
import type { Id } from "../src/convex/_generated/dataModel";

export const modules = import.meta.glob("../src/convex/**/*.ts");

export function newBackend() {
  return convexTest(schema, modules);
}
export type Backend = ReturnType<typeof newBackend>;

/** Create a user row and return a client authenticated as that user. */
export async function signedInAs(
  t: Backend,
  fields: { email?: string; role?: "admin" | "pfa" | "user"; isAnonymous?: boolean; pfaId?: Id<"pfas"> } = {},
) {
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      email: fields.email,
      role: fields.role,
      isAnonymous: fields.isAnonymous,
      pfaId: fields.pfaId,
      emailVerificationTime: fields.email ? Date.now() : undefined,
    }),
  );
  const client = t.withIdentity({ subject: `${userId}|session-${userId}` });
  return { userId, client };
}

export async function seedPfas(t: Backend) {
  await t.mutation(internal.pfaDirectory.seedDirectory, {});
}

/** Register an employer through the real onboarding mutation, then approve it as an admin. */
export async function approvedEmployer(t: Backend, email: string, rc: string) {
  const owner = await signedInAs(t, { email });
  const { api } = await import("../src/convex/_generated/api");
  const { employerId } = await owner.client.mutation(api.pension.registerEmployer, {
    name: `${rc} Ltd`,
    rcNumber: rc,
    tin: `TIN-${rc}`,
    registeredAddress: "1 Marina, Lagos",
    contactEmail: email,
    contactPhone: "+2348000000000",
    representativeName: "Test Rep",
  });
  const admin = await ensureAdmin(t);
  await admin.client.mutation(api.admin.adminSetEmployerStatus, { employerId, status: "active" });
  return { ...owner, employerId };
}

let adminCache = new WeakMap<Backend, Awaited<ReturnType<typeof signedInAs>>>();
export async function ensureAdmin(t: Backend) {
  const hit = adminCache.get(t);
  if (hit) return hit;
  const admin = await signedInAs(t, { email: "ops-admin@penroute.test", role: "admin" });
  adminCache.set(t, admin);
  return admin;
}
export function resetAdminCache() {
  adminCache = new WeakMap();
}

export const schedule = (n: number, pfaCodes = ["101", "105", "106"]) =>
  Array.from({ length: n }, (_, i) => ({
    fullName: `Employee ${i + 1}`,
    employeeCode: `EMP-${i + 1}`,
    pensionPin: `PEN${String(100000 + i)}`,
    pfaCode: pfaCodes[i % pfaCodes.length],
    employeeContribution: 8000 + i,
    employerContribution: 10000.5,
  }));

export async function hmacSha512Hex(key: string, body: string) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
