import { v } from "convex/values";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getCurrentUser } from "./users";
import { audit, getEmployerForUser } from "./employers";
import { notify } from "./notifications";

// ============================================================================
// KYB DOCUMENTS — employers upload company registration evidence (CAC
// certificate, TIN, director ID, …) to Convex file storage. Files are only
// readable by the owning employer and platform admins; admins accept/reject
// each document before approving the employer.
// ============================================================================

export const KYB_KINDS = [
  "cac_certificate",
  "tin_certificate",
  "director_id",
  "utility_bill",
  "board_resolution",
  "other",
] as const;
const ALLOWED_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DOCS = 30;

/** Short-lived upload URL for the signed-in employer owner. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const employer = await getEmployerForUser(ctx, user);
    if (!employer) throw new Error("Register your company before uploading documents");
    return await ctx.storage.generateUploadUrl();
  },
});

/** Detect the real file type from its first bytes (the browser-supplied
 *  Content-Type is attacker-controlled, so it is never trusted). */
function sniff(bytes: Uint8Array): string | null {
  const at = (i: number, sig: number[]) => sig.every((b, k) => bytes[i + k] === b);
  if (at(0, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}

/** Attach an uploaded file to the employer. Type is verified from the file's
 *  own bytes and size from storage metadata; rejected uploads are deleted. */
export const attachDocument = action({
  args: {
    storageId: v.id("_storage"),
    kind: v.string(),
    fileName: v.string(),
  },
  handler: async (ctx, { storageId, kind, fileName }): Promise<{ documentId: Id<"kybDocuments"> }> => {
    const blob = await ctx.storage.get(storageId);
    if (!blob) throw new Error("Upload not found — please try again");
    const reject = async (msg: string): Promise<never> => {
      await ctx.storage.delete(storageId);
      throw new Error(msg);
    };
    if (blob.size > MAX_BYTES) return await reject("Files must be 10 MB or smaller");
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const contentType = sniff(head);
    if (!contentType || !ALLOWED_TYPES.has(contentType)) return await reject("Upload a PDF, PNG, JPEG or WebP file");
    try {
      return await ctx.runMutation(internal.kyb.recordDocument, {
        storageId,
        kind,
        fileName,
        contentType,
        size: blob.size,
      });
    } catch (e) {
      await ctx.storage.delete(storageId);
      throw e;
    }
  },
});

export const recordDocument = internalMutation({
  args: {
    storageId: v.id("_storage"),
    kind: v.string(),
    fileName: v.string(),
    contentType: v.string(),
    size: v.number(),
  },
  handler: async (ctx, { storageId, kind, fileName, contentType, size }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const employer = await getEmployerForUser(ctx, user);
    if (!employer) throw new Error("No employer profile");
    if (!(KYB_KINDS as readonly string[]).includes(kind)) throw new Error("Unknown document type");
    const already = await ctx.db
      .query("kybDocuments")
      .withIndex("by_employer", (q) => q.eq("employerId", employer._id))
      .take(MAX_DOCS + 1);
    if (already.some((d) => d.storageId === storageId)) throw new Error("This file is already attached");
    if (already.length >= MAX_DOCS) throw new Error(`At most ${MAX_DOCS} documents per company`);

    const cleanName = fileName.replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "document";
    const id = await ctx.db.insert("kybDocuments", {
      employerId: employer._id,
      storageId,
      kind,
      fileName: cleanName,
      contentType,
      size,
      status: "submitted",
      uploadedBy: user._id,
      createdAt: Date.now(),
    });
    await audit(ctx, {
      actor: user.email ?? "unknown",
      action: "kyb_document_uploaded",
      entityType: "employer",
      entityId: employer._id,
      employerId: employer._id,
      details: `${kind}: ${cleanName} (${Math.round(size / 1024)} KB)`,
    });
    await notify(ctx, {
      audience: "admin",
      kind: "kyb_document",
      title: `KYB document from ${employer.name}`,
      body: `${employer.name} uploaded ${kind.replace(/_/g, " ")} (${cleanName}) for review.`,
      link: "/admin",
    });
    return { documentId: id };
  },
});

/** Documents for the caller's employer, or (admin) for any employer. */
export const listDocuments = query({
  args: { employerId: v.optional(v.id("employers")) },
  handler: async (ctx, { employerId }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    let target = employerId;
    if (user.role !== "admin") {
      const own = await getEmployerForUser(ctx, user);
      if (!own) return [];
      if (employerId && employerId !== own._id) throw new Error("Not authorized");
      target = own._id;
    }
    if (!target) return [];
    const docs = await ctx.db
      .query("kybDocuments")
      .withIndex("by_employer", (q) => q.eq("employerId", target!))
      .take(MAX_DOCS);
    return Promise.all(
      docs
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(async (d) => ({
          _id: d._id,
          kind: d.kind,
          fileName: d.fileName,
          contentType: d.contentType,
          size: d.size,
          status: d.status,
          reviewNote: d.reviewNote ?? null,
          createdAt: d.createdAt,
          url: await ctx.storage.getUrl(d.storageId),
        })),
    );
  },
});

/** Owner may delete a document that has not been accepted yet. */
export const removeDocument = mutation({
  args: { documentId: v.id("kybDocuments") },
  handler: async (ctx, { documentId }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const doc = await ctx.db.get(documentId);
    if (!doc) throw new Error("Document not found");
    const own = await getEmployerForUser(ctx, user);
    if (!own || own._id !== doc.employerId) throw new Error("Not authorized");
    if (doc.status === "accepted") throw new Error("Accepted documents are kept for the audit record");
    await ctx.storage.delete(doc.storageId);
    await ctx.db.delete(documentId);
    await audit(ctx, {
      actor: user.email ?? "unknown",
      action: "kyb_document_removed",
      entityType: "employer",
      entityId: doc.employerId,
      employerId: doc.employerId,
      details: `${doc.kind}: ${doc.fileName}`,
    });
    return { ok: true };
  },
});

/** Admin review of one document. */
export const reviewDocument = mutation({
  args: {
    documentId: v.id("kybDocuments"),
    decision: v.union(v.literal("accepted"), v.literal("rejected")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { documentId, decision, note }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    if (user.role !== "admin") throw new Error("Admin access required");
    const doc = await ctx.db.get(documentId);
    if (!doc) throw new Error("Document not found");
    if (decision === "rejected" && !(note ?? "").trim()) throw new Error("Give the employer a reason for the rejection");
    await ctx.db.patch(documentId, {
      status: decision,
      reviewNote: note?.trim().slice(0, 500),
      reviewedBy: user.email ?? "admin",
      reviewedAt: Date.now(),
    });
    const employer = await ctx.db.get(doc.employerId);
    await audit(ctx, {
      actor: user.email ?? "admin",
      action: `kyb_document_${decision}`,
      entityType: "employer",
      entityId: doc.employerId,
      employerId: doc.employerId,
      field: "status",
      before: doc.status,
      after: decision,
      details: `${doc.kind}: ${doc.fileName}${note ? ` — ${note.trim().slice(0, 200)}` : ""}`,
    });
    if (decision === "rejected") {
      await notify(ctx, {
        audience: "employer",
        employerId: doc.employerId,
        kind: "kyb_document_rejected",
        title: "A registration document needs attention",
        body: `Your ${doc.kind.replace(/_/g, " ")} (${doc.fileName}) was not accepted: ${note!.trim()}. Please upload a replacement in Settings.`,
        link: "/dashboard/settings",
      });
    }
    void employer;
    return { ok: true };
  },
});
