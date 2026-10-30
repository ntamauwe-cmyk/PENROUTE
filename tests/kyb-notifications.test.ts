import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/convex/_generated/api";
import {
  approvedEmployer,
  ensureAdmin,
  hmacSha512Hex,
  newBackend,
  resetAdminCache,
  schedule,
  seedPfas,
  signedInAs,
  type Backend,
} from "./helpers";

let t: Backend;
beforeEach(async () => {
  vi.useFakeTimers();
  resetAdminCache();
  t = newBackend();
  await seedPfas(t);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const reg = {
  name: "DocCo Ltd",
  rcNumber: "RC-DOC-1",
  tin: "TIN-DOC",
  registeredAddress: "Lagos",
  contactEmail: "hr@docco.test",
  contactPhone: "+234",
  representativeName: "Ada",
};

describe("terms acceptance", () => {
  test("registration requires accepting the terms and records the version", async () => {
    const u = await signedInAs(t, { email: "hr@docco.test" });
    await expect(u.client.mutation(api.pension.registerEmployer, { ...reg, acceptTerms: false })).rejects.toThrow(
      /Terms/,
    );
    const { employerId } = await u.client.mutation(api.pension.registerEmployer, { ...reg, acceptTerms: true });
    const e = await t.run((ctx) => ctx.db.get(employerId));
    expect(e?.termsVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(e?.termsAcceptedBy).toBe(u.userId);
  });
});

describe("KYB documents", () => {
  async function storeFile(type: string, bytes = 2048) {
    const body = new Uint8Array(bytes);
    if (type === "application/pdf") body.set([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    if (type === "application/x-msdownload") body.set([0x4d, 0x5a]);
    return t.run((ctx) => ctx.storage.store(new Blob([body], { type })));
  }

  test("upload, owner-only visibility, type checks, admin review", async () => {
    const owner = await signedInAs(t, { email: "hr@docco.test" });
    const { employerId } = await owner.client.mutation(api.pension.registerEmployer, { ...reg, acceptTerms: true });

    const exe = await storeFile("application/x-msdownload");
    await expect(
      owner.client.action(api.kyb.attachDocument, { storageId: exe, kind: "cac_certificate", fileName: "x.exe" }),
    ).rejects.toThrow(/PDF, PNG/);

    const pdf = await storeFile("application/pdf");
    await owner.client.action(api.kyb.attachDocument, {
      storageId: pdf,
      kind: "cac_certificate",
      fileName: "../../CAC cert.pdf",
    });
    const mine = await owner.client.query(api.kyb.listDocuments, {});
    expect(mine).toHaveLength(1);
    expect(mine[0].fileName).not.toContain("/");
    expect(mine[0].status).toBe("submitted");

    // Another employer cannot see or delete it.
    const other = await approvedEmployer(t, "x@other.test", "RC-OTHER");
    await expect(other.client.query(api.kyb.listDocuments, { employerId })).rejects.toThrow(/Not authorized/);
    expect((await other.client.query(api.kyb.listDocuments, {})).map((d) => d._id)).not.toContain(mine[0]._id);
    await expect(other.client.mutation(api.kyb.removeDocument, { documentId: mine[0]._id })).rejects.toThrow(
      /Not authorized/,
    );

    // Admin sees it, rejection needs a reason and notifies the employer.
    const admin = await ensureAdmin(t);
    expect(await admin.client.query(api.kyb.listDocuments, { employerId })).toHaveLength(1);
    await expect(owner.client.mutation(api.kyb.reviewDocument, { documentId: mine[0]._id, decision: "accepted" })).rejects.toThrow(/Admin/);
    await expect(admin.client.mutation(api.kyb.reviewDocument, { documentId: mine[0]._id, decision: "rejected" })).rejects.toThrow(/reason/);
    await admin.client.mutation(api.kyb.reviewDocument, {
      documentId: mine[0]._id,
      decision: "rejected",
      note: "Certificate is cut off",
    });
    const inbox = await owner.client.query(api.notifications.listMine, {});
    expect(inbox.map((n) => n.kind)).toContain("kyb_document_rejected");
    const adminInbox = await admin.client.query(api.notifications.listMine, {});
    expect(adminInbox.map((n) => n.kind)).toEqual(expect.arrayContaining(["employer_application", "kyb_document"]));
  });
});

describe("notifications", () => {
  test("approval and payment events reach the employer inbox; email sent when configured", async () => {
    const KEY = "sk_test_notifications_suite_0000000000000";
    vi.stubEnv("PAYSTACK_SECRET_KEY", KEY);
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("NOTIFY_FROM_EMAIL", "Penroute <no-reply@penroute.net>");
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("resend.com")) {
          sent.push(JSON.parse(String(init?.body)).subject);
          return new Response("{}", { status: 200 });
        }
        return new Response("{}", { status: 404 });
      }),
    );
    const admin = await ensureAdmin(t);
    await admin.client.mutation(api.admin.adminSetRailMode, { mode: "live" });
    const emp = await approvedEmployer(t, "pay@notify.test", "RC-NTF");
    const { batchId } = await emp.client.mutation(api.engine.prepareBatch, { year: 2026, month: 6, records: schedule(2) });
    const pay = await emp.client.mutation(api.engine.payBatch, { batchId });
    if (!("requiresCheckout" in pay)) throw new Error("expected checkout");
    const body = JSON.stringify({
      event: "charge.success",
      data: { reference: pay.paymentRef, amount: pay.amountKobo, currency: "NGN", status: "success" },
    });
    await t.fetch("/webhooks/paystack", { method: "POST", headers: { "x-paystack-signature": await hmacSha512Hex(KEY, body) }, body });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const inbox = await emp.client.query(api.notifications.listMine, {});
    const kinds = inbox.map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(["registration_received", "employer_approved", "payment_confirmed"]));
    expect(inbox.every((n) => n.emailStatus === "sent")).toBe(true);
    expect(sent).toEqual(expect.arrayContaining(["Penroute: Payment confirmed"]));

    // PFA operators get the awaiting-confirmation notice in their own inbox only.
    const settlement = await t.run(async (ctx) =>
      (await ctx.db.query("settlements").withIndex("by_batch", (q) => q.eq("batchId", batchId)).first())!,
    );
    const op = await signedInAs(t, { email: "op@pfa.test", role: "pfa", pfaId: settlement.pfaId });
    const opInbox = await op.client.query(api.notifications.listMine, {});
    expect(opInbox).toHaveLength(1);
    expect(opInbox[0].kind).toBe("settlement_awaiting_confirmation");

    // Read receipts: users can only mark their own notifications.
    await op.client.mutation(api.notifications.markRead, { ids: inbox.map((n) => n._id) });
    expect((await emp.client.query(api.notifications.listMine, {})).every((n) => !n.readAt)).toBe(true);
    await emp.client.mutation(api.notifications.markRead, { ids: inbox.map((n) => n._id) });
    expect((await emp.client.query(api.notifications.listMine, {})).every((n) => n.readAt)).toBe(true);
  });

  test("without an email provider, notifications are kept in-app and marked not_configured", async () => {
    const u = await signedInAs(t, { email: "hr@docco.test" });
    await u.client.mutation(api.pension.registerEmployer, { ...reg, acceptTerms: true });
    const [n] = await u.client.query(api.notifications.listMine, {});
    expect(n.emailStatus).toBe("not_configured");
  });
});
