import { useRef, useState } from "react";
import { friendlyError } from "@/lib/errors";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { fmtDateTime } from "@/lib/pension";
import { FileText, Loader2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

const KINDS: { value: string; label: string }[] = [
  { value: "cac_certificate", label: "CAC certificate of incorporation" },
  { value: "tin_certificate", label: "TIN certificate" },
  { value: "director_id", label: "Director / signatory ID" },
  { value: "utility_bill", label: "Proof of address (utility bill)" },
  { value: "board_resolution", label: "Board resolution / authorisation letter" },
  { value: "other", label: "Other supporting document" },
];
const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label ?? k;

function statusBadge(status: string) {
  const cls =
    status === "accepted"
      ? "bg-[#E6F6EF] text-[#04593A]"
      : status === "rejected"
        ? "bg-[#FBEAE8] text-[#8A2F28]"
        : "bg-[#FBF3E0] text-[#7A5A10]";
  return <Badge className={cls}>{status === "submitted" ? "under review" : status}</Badge>;
}

/** Employer view: upload and track company registration documents. */
export function KybDocumentsUpload() {
  const docs = useQuery(api.kyb.listDocuments, {});
  const getUrl = useMutation(api.kyb.generateUploadUrl);
  const attach = useAction(api.kyb.attachDocument);
  const remove = useMutation(api.kyb.removeDocument);
  const [kind, setKind] = useState(KINDS[0].value);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    if (file.size > 10 * 1024 * 1024) {
      toast.error("Files must be 10 MB or smaller");
      return;
    }
    setBusy(true);
    try {
      const url = await getUrl({});
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!res.ok) throw new Error("Upload failed — please try again");
      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      await attach({ storageId, kind, fileName: file.name });
      toast.success("Document uploaded for review");
    } catch (e) {
      toast.error(friendlyError(e, "Upload failed"));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <section className="pen-card-lg p-6">
      <h2 className="flex items-center gap-2 font-bold tracking-tight">
        <FileText className="size-5 text-primary" /> Company documents (KYB)
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Upload your CAC certificate, TIN certificate and a director's ID. PDF, PNG, JPEG or WebP, up to
        10 MB each. Only you and Penroute compliance can see these files.
      </p>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          aria-label="Document type"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <Input
          ref={fileRef}
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/webp"
          className="sr-only"
          id="kyb-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
        <Button asChild={!busy} disabled={busy} className="font-semibold">
          {busy ? (
            <span>
              <Loader2 className="size-4 animate-spin" /> Uploading…
            </span>
          ) : (
            <label htmlFor="kyb-file" className="cursor-pointer">
              <Upload className="size-4" /> Choose file
            </label>
          )}
        </Button>
      </div>
      <DocumentList docs={docs} onRemove={(id) => void remove({ documentId: id }).catch((e: unknown) => toast.error(friendlyError(e)))} />
    </section>
  );
}

type DocRow = {
  _id: Id<"kybDocuments">;
  kind: string;
  fileName: string;
  size: number;
  status: string;
  reviewNote: string | null;
  createdAt: number;
  url: string | null;
};

function DocumentList({
  docs,
  onRemove,
  review,
}: {
  docs: DocRow[] | undefined;
  onRemove?: (id: Id<"kybDocuments">) => void;
  review?: (id: Id<"kybDocuments">, decision: "accepted" | "rejected") => void;
}) {
  if (docs === undefined) return <p className="mt-4 text-sm text-muted-foreground">Loading…</p>;
  if (docs.length === 0) return <p className="mt-4 text-sm text-muted-foreground">No documents uploaded yet.</p>;
  return (
    <ul className="mt-4 divide-y rounded-lg border">
      {docs.map((d) => (
        <li key={d._id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
          <div className="min-w-0 flex-1">
            <p className="font-medium">{kindLabel(d.kind)}</p>
            <p className="truncate text-xs text-muted-foreground">
              {d.url ? (
                <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-[#007A4D] hover:underline">
                  {d.fileName}
                </a>
              ) : (
                d.fileName
              )}{" "}
              · {Math.max(1, Math.round(d.size / 1024))} KB · {fmtDateTime(d.createdAt)}
            </p>
            {d.reviewNote && <p className="text-xs text-[#8A2F28]">{d.reviewNote}</p>}
          </div>
          {statusBadge(d.status)}
          {review && d.status === "submitted" && (
            <>
              <Button size="sm" variant="outline" onClick={() => review(d._id, "accepted")}>
                Accept
              </Button>
              <Button size="sm" variant="ghost" onClick={() => review(d._id, "rejected")}>
                Reject
              </Button>
            </>
          )}
          {onRemove && d.status !== "accepted" && (
            <Button size="icon" variant="ghost" aria-label={`Remove ${d.fileName}`} onClick={() => onRemove(d._id)}>
              <Trash2 className="size-4" />
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Admin view: review one employer's documents. */
export function KybDocumentsReview({ employerId }: { employerId: Id<"employers"> }) {
  const docs = useQuery(api.kyb.listDocuments, { employerId });
  const review = useMutation(api.kyb.reviewDocument);
  return (
    <DocumentList
      docs={docs}
      review={async (id, decision) => {
        let note: string | undefined;
        if (decision === "rejected") {
          note = window.prompt("Reason for rejecting this document (sent to the employer):") ?? undefined;
          if (!note?.trim()) return;
        }
        try {
          await review({ documentId: id, decision, note });
          toast.success(`Document ${decision}`);
        } catch (e) {
          toast.error(friendlyError(e, "Review failed"));
        }
      }}
    />
  );
}
