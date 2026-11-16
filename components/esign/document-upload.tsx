"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { csrfToken } from "@/lib/client/api";

const ACCEPT = ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_BYTES = 25 * 1024 * 1024;

export interface UploadedDocument {
  id: string;
  title: string;
  latest: { id: string; version: number; pageCount: number };
}

async function postFile(url: string, form: FormData): Promise<{ document?: UploadedDocument; version?: { id: string } }> {
  const res = await fetch(url, { method: "POST", headers: { "X-CSRF-Token": csrfToken() }, body: form, credentials: "same-origin" });
  const data = (await res.json().catch(() => null)) as { error?: { message?: string }; document?: UploadedDocument; version?: { id: string } } | null;
  if (!res.ok) throw new Error(data?.error?.message ?? `Upload failed (${res.status}).`);
  return data ?? {};
}

/** Upload a new document, or a new version of an existing one when documentId is set. */
export function DocumentUpload({
  documentId,
  label,
  variant = "primary",
  onUploaded,
}: {
  documentId?: string;
  label?: string;
  variant?: "primary" | "secondary" | "outline";
  /** When set, the new document is handed back instead of opening its page. */
  onUploaded?: (doc: UploadedDocument) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pick(f: File | undefined) {
    setError(null);
    if (!f) return;
    if (f.size > MAX_BYTES) {
      setError("The file is larger than 25 MB.");
      return;
    }
    if (!/\.(pdf|docx)$/i.test(f.name)) {
      setError("Only PDF and Word (.docx) files can be uploaded.");
      return;
    }
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.(pdf|docx)$/i, ""));
  }

  async function submit() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      if (!documentId) form.append("title", title);
      const data = await postFile(documentId ? `/api/documents/${documentId}/versions` : "/api/documents", form);
      toast.success(documentId ? "New version uploaded" : "Document uploaded", /\.docx$/i.test(file.name) ? "The Word file was converted to PDF." : undefined);
      setOpen(false);
      setFile(null);
      setTitle("");
      if (!documentId && data.document && onUploaded) onUploaded(data.document);
      else if (!documentId && data.document) router.push(`/esign/documents/${data.document.id}`);
      else router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant={variant} size="sm" onClick={() => setOpen(true)}>
        <Upload aria-hidden />
        {label ?? (documentId ? "Upload new version" : "Upload document")}
      </Button>
      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        title={documentId ? "Upload a new version" : "Upload a document"}
        description="PDF or Word (.docx), up to 25 MB. Word files are converted to PDF so every signer sees the same pages."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} loading={busy} disabled={!file}>
              Upload
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <label
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong bg-panel-2 px-4 py-8 text-center transition-colors hover:border-accent/40"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              pick(e.dataTransfer.files[0]);
            }}
          >
            <Upload className="h-5 w-5 text-accent-strong" aria-hidden />
            <span className="text-sm font-medium text-fg">{file ? file.name : "Choose a file or drop it here"}</span>
            <span className="type-caption text-muted">{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "PDF or DOCX"}</span>
            <input ref={inputRef} type="file" accept={ACCEPT} className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
          </label>
          {!documentId && (
            <Field label="Title" htmlFor="doc-title" hint="Shown to recipients in the signing email.">
              <Input id="doc-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Mutual NDA" />
            </Field>
          )}
          {error && (
            <p className="type-caption text-danger" role="alert">
              {error}
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}
