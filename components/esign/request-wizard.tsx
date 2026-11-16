"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, Plus, Send, Trash2 } from "lucide-react";
import { Alert } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { DocumentUpload } from "./document-upload";
import { FieldEditor, FIELD_META, RECIPIENT_COLORS, newFieldKey, type EditorField, type FieldType } from "./field-editor";

export interface WizardDocument {
  id: string;
  title: string;
  versions: { id: string; version: number; pageCount: number }[];
}

type Role = "SIGNER" | "APPROVER" | "CC";

interface RecipientRow {
  key: string;
  id?: string;
  name: string;
  email: string;
  role: Role;
  routingOrder: number;
  phone: string;
  requireSmsOtp: boolean;
}

export interface WizardDraft {
  id: string;
  documentVersionId: string;
  title: string;
  subject: string;
  message: string | null;
  signingOrder: "SEQUENTIAL" | "PARALLEL";
  expiresAt: string;
  reminderEveryDays: number;
  senderCompany: string | null;
  recipients: { id: string; name: string; email: string; role: Role; routingOrder: number; phone: string | null; requireSmsOtp: boolean }[];
  fields: { id: string; recipientId: string; type: FieldType; page: number; x: number; y: number; width: number; height: number; required: boolean; label: string | null }[];
}

interface ServerRequest {
  request: WizardDraft & { status: string };
  problems: string[];
}

const STEPS = ["Document", "Recipients", "Message", "Fields", "Review & send"];
const DAY_MS = 24 * 60 * 60 * 1000;

let rowSeq = 0;
function rowKey(): string {
  rowSeq += 1;
  return `r${rowSeq}`;
}

function toRows(draft?: WizardDraft): RecipientRow[] {
  if (!draft) return [{ key: rowKey(), name: "", email: "", role: "SIGNER", routingOrder: 1, phone: "", requireSmsOtp: false }];
  return draft.recipients.map((r) => ({ key: rowKey(), id: r.id, name: r.name, email: r.email, role: r.role, routingOrder: r.routingOrder, phone: r.phone ?? "", requireSmsOtp: r.requireSmsOtp }));
}

function toEditorFields(fields: WizardDraft["fields"]): EditorField[] {
  return fields.map((f) => ({ key: f.id || newFieldKey(), recipientId: f.recipientId, type: f.type, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, required: f.required, label: f.label ?? undefined }));
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const details = Array.isArray(err.details) ? (err.details as { path?: string; message?: string }[]) : [];
    return details.length > 1 ? details.map((d) => d.message).join(" · ") : err.message;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

export function RequestWizard({
  documents: initialDocuments,
  initialVersionId,
  draft,
  initialStep = 0,
  initialProblems,
  sender,
  emailAccount,
  smsAvailable,
}: {
  documents: WizardDocument[];
  initialVersionId?: string;
  draft?: WizardDraft;
  initialStep?: number;
  /** Server-computed send blockers for an existing draft. */
  initialProblems?: string[];
  sender: { name: string; email: string; company: string | null };
  emailAccount: string | null;
  smsAvailable: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [documents, setDocuments] = useState(initialDocuments);
  const [step, setStep] = useState(draft ? Math.min(Math.max(initialStep, 0), STEPS.length - 1) : 0);
  const [requestId, setRequestId] = useState(draft?.id ?? null);
  const [versionId, setVersionId] = useState(draft?.documentVersionId ?? initialVersionId ?? documents[0]?.versions[0]?.id ?? "");
  const [title, setTitle] = useState(() => draft?.title ?? documents.find((d) => d.versions.some((v) => v.id === (initialVersionId ?? documents[0]?.versions[0]?.id)))?.title ?? "");
  const [subject, setSubject] = useState(draft?.subject ?? "");
  const [message, setMessage] = useState(draft?.message ?? "");
  const [signingOrder, setSigningOrder] = useState<"SEQUENTIAL" | "PARALLEL">(draft?.signingOrder ?? "SEQUENTIAL");
  const [now] = useState(() => Date.now());
  const [expiresInDays, setExpiresInDays] = useState(() => (draft ? Math.min(365, Math.max(1, Math.ceil((Date.parse(draft.expiresAt) - now) / DAY_MS))) : 14));
  const [reminderEveryDays, setReminderEveryDays] = useState(draft?.reminderEveryDays ?? 2);
  const [senderCompany, setSenderCompany] = useState(draft?.senderCompany ?? sender.company ?? "");
  const [rows, setRows] = useState<RecipientRow[]>(() => toRows(draft));
  const [fields, setFields] = useState<EditorField[]>(() => toEditorFields(draft?.fields ?? []));
  const [problems, setProblems] = useState<string[]>(initialProblems ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);

  const selectedDoc = useMemo(() => documents.find((d) => d.versions.some((v) => v.id === versionId)), [documents, versionId]);
  const selectedVersion = selectedDoc?.versions.find((v) => v.id === versionId);
  const savedRecipients = useMemo(() => rows.filter((r) => r.id).map((r) => ({ id: r.id!, name: r.name, email: r.email, role: r.role })), [rows]);

  async function refresh(id: string) {
    const data = await api<ServerRequest>(`/api/signature-requests/${id}`);
    setRows(toRows(data.request));
    setFields(toEditorFields(data.request.fields));
    setProblems(data.problems);
    return data;
  }

  function validateLocal(target: number): string | null {
    if (target >= 1 && !versionId) return "Choose or upload a document first.";
    if (target >= 2) {
      if (!rows.length) return "Add at least one recipient.";
      for (const r of rows) {
        if (!r.name.trim()) return "Every recipient needs a name.";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email.trim())) return `Enter a valid email for ${r.name || "each recipient"}.`;
        if (r.requireSmsOtp && !r.phone.trim()) return `${r.name} needs a phone number for SMS verification.`;
      }
      const emails = rows.map((r) => r.email.trim().toLowerCase());
      if (new Set(emails).size !== emails.length) return "Each recipient email can only be listed once.";
      if (!rows.some((r) => r.role !== "CC")) return "Add at least one signer or approver.";
    }
    if (target >= 3 && !title.trim()) return "Give the request a title.";
    return null;
  }

  function payload() {
    return {
      documentVersionId: versionId,
      title: title.trim(),
      subject: subject.trim() || undefined,
      message: message.trim() || undefined,
      signingOrder,
      expiresInDays,
      reminderEveryDays,
      senderCompany: senderCompany.trim() || undefined,
      recipients: rows.map((r) => ({
        name: r.name.trim(),
        email: r.email.trim().toLowerCase(),
        role: r.role,
        routingOrder: signingOrder === "PARALLEL" ? 1 : r.routingOrder,
        phone: r.phone.trim() || undefined,
        requireSmsOtp: r.requireSmsOtp,
      })),
    };
  }

  async function saveDraft(): Promise<string> {
    if (requestId) {
      await api(`/api/signature-requests/${requestId}`, { method: "PATCH", body: payload() });
      await refresh(requestId);
      return requestId;
    }
    const created = await api<{ request: { id: string } }>("/api/signature-requests", { method: "POST", body: payload() });
    setRequestId(created.request.id);
    await refresh(created.request.id);
    router.replace(`/esign/requests/${created.request.id}/edit?step=3`, { scroll: false });
    return created.request.id;
  }

  async function saveFields(id: string) {
    const res = await api<{ problems: string[] }>("/api/signature-fields", {
      method: "PUT",
      body: {
        requestId: id,
        fields: fields.map((f) => ({ recipientId: f.recipientId, type: f.type, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, required: f.required, label: f.label || undefined })),
      },
    });
    await refresh(id);
    setProblems(res.problems);
  }

  async function goTo(target: number) {
    setError(null);
    if (target > step) {
      const local = validateLocal(target);
      if (local) {
        setError(local);
        return;
      }
    }
    setBusy(true);
    try {
      if (step <= 2 && target >= 3) await saveDraft();
      if (step === 3 && requestId) await saveFields(requestId);
      if (target === 4 && requestId && step !== 3) await refresh(requestId);
      setStep(target);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!requestId) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/signature-requests/${requestId}/send`, { method: "POST", body: { confirm: true } });
      toast.success("Signing request sent", "Recipients will get a Review Document email.");
      router.push(`/esign/requests/${requestId}`);
      router.refresh();
    } catch (err) {
      setError(errorText(err));
      await refresh(requestId).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  function updateRow(key: string, patch: Partial<RecipientRow>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function moveRow(index: number, dir: -1 | 1) {
    setRows((rs) => {
      const next = [...rs];
      const [item] = next.splice(index, 1);
      next.splice(index + dir, 0, item);
      return next.map((r, i) => ({ ...r, routingOrder: i + 1 }));
    });
  }

  const fieldCount = (recipientId: string) => fields.filter((f) => f.recipientId === recipientId).length;

  return (
    <div className="space-y-5">
      <ol className="flex flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label}>
            <button
              type="button"
              onClick={() => (i < step || (requestId && i <= 4) ? goTo(i) : undefined)}
              disabled={busy || (!requestId && i > step)}
              aria-current={i === step ? "step" : undefined}
              className={cn(
                "type-caption flex items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors",
                i === step ? "border-accent bg-accent-soft text-fg" : i < step ? "border-line-strong text-muted hover:text-fg" : "border-line text-subtle",
              )}
            >
              <span className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[11px]", i < step ? "bg-success text-white" : "bg-panel-3")}>
                {i < step ? <Check className="h-3 w-3" aria-hidden /> : i + 1}
              </span>
              {label}
            </button>
          </li>
        ))}
      </ol>

      {error && <Alert tone="danger" title="Check this step">{error}</Alert>}

      {step === 0 && (
        <Card>
          <CardHeader title="Choose the document" description="Pick an uploaded document or upload a new PDF or Word file." actions={<DocumentUpload variant="secondary" label="Upload new" onUploaded={(d) => {
            setDocuments((ds) => [{ id: d.id, title: d.title, versions: [{ id: d.latest.id, version: d.latest.version, pageCount: d.latest.pageCount }] }, ...ds]);
            setVersionId(d.latest.id);
            setTitle(d.title);
          }} />} />
          <CardBody>
            {!documents.length ? (
              <p className="type-body-sm text-muted">No documents yet. Upload one to continue.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {documents.map((d) => (
                  <label key={d.id} className={cn("flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors", selectedDoc?.id === d.id ? "border-accent bg-accent-soft" : "border-line-strong hover:border-accent/40")}>
                    <input type="radio" name="doc" className="mt-1" checked={selectedDoc?.id === d.id} onChange={() => {
                      setVersionId(d.versions[0]?.id ?? "");
                      if (!title.trim() || documents.some((x) => x.title === title)) setTitle(d.title);
                    }} style={{ accentColor: "var(--accent)" }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">{d.title}</span>
                      {selectedDoc?.id === d.id && d.versions.length > 1 ? (
                        <select className="mt-1 rounded border border-line-strong bg-panel-2 px-1 py-0.5 text-xs text-fg" value={versionId} onChange={(e) => setVersionId(e.target.value)} aria-label="Version">
                          {d.versions.map((v) => (
                            <option key={v.id} value={v.id}>
                              Version {v.version} · {v.pageCount} pages
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="type-caption text-muted">
                          v{d.versions[0]?.version} · {d.versions[0]?.pageCount} page{d.versions[0]?.pageCount === 1 ? "" : "s"}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {step === 1 && (
        <Card>
          <CardHeader title="Recipients" description="Signers and approvers sign; CC recipients get a copy of the completed document." />
          <CardBody className="space-y-4">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Signing order">
              {(["SEQUENTIAL", "PARALLEL"] as const).map((o) => (
                <button
                  key={o}
                  type="button"
                  role="radio"
                  aria-checked={signingOrder === o}
                  onClick={() => setSigningOrder(o)}
                  className={cn("rounded-md border px-3 py-2 text-left text-sm", signingOrder === o ? "border-accent bg-accent-soft text-fg" : "border-line-strong text-muted hover:text-fg")}
                >
                  <span className="block font-medium">{o === "SEQUENTIAL" ? "In order" : "All at once"}</span>
                  <span className="type-caption">{o === "SEQUENTIAL" ? "Each recipient is emailed after the previous one signs." : "Everyone is emailed now and can sign in any order."}</span>
                </button>
              ))}
            </div>
            <ul className="space-y-3">
              {rows.map((r, i) => (
                <li key={r.key} className="rounded-md border border-line bg-panel-2/50 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="type-mono-label flex items-center gap-2 text-muted">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: RECIPIENT_COLORS[i % RECIPIENT_COLORS.length] }} aria-hidden />
                      Recipient {i + 1}
                    </span>
                    <span className="flex items-center gap-1">
                      {signingOrder === "SEQUENTIAL" && (
                        <>
                          <Button variant="ghost" size="icon-sm" aria-label="Move up" disabled={i === 0} onClick={() => moveRow(i, -1)}>
                            <ArrowUp />
                          </Button>
                          <Button variant="ghost" size="icon-sm" aria-label="Move down" disabled={i === rows.length - 1} onClick={() => moveRow(i, 1)}>
                            <ArrowDown />
                          </Button>
                        </>
                      )}
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove recipient ${i + 1}`} disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                        <Trash2 />
                      </Button>
                    </span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_9rem_6rem]">
                    <Field label="Full name" htmlFor={`name-${r.key}`}>
                      <Input id={`name-${r.key}`} value={r.name} maxLength={120} autoComplete="off" onChange={(e) => updateRow(r.key, { name: e.target.value })} />
                    </Field>
                    <Field label="Email" htmlFor={`email-${r.key}`}>
                      <Input id={`email-${r.key}`} type="email" value={r.email} maxLength={254} autoComplete="off" onChange={(e) => updateRow(r.key, { email: e.target.value })} />
                    </Field>
                    <Field label="Role" htmlFor={`role-${r.key}`}>
                      <Select id={`role-${r.key}`} value={r.role} onChange={(e) => updateRow(r.key, { role: e.target.value as Role })}>
                        <option value="SIGNER">Signer</option>
                        <option value="APPROVER">Approver</option>
                        <option value="CC">CC (copy)</option>
                      </Select>
                    </Field>
                    {signingOrder === "SEQUENTIAL" && (
                      <Field label="Order" htmlFor={`order-${r.key}`}>
                        <Input id={`order-${r.key}`} type="number" min={1} max={50} value={r.routingOrder} onChange={(e) => updateRow(r.key, { routingOrder: Math.min(50, Math.max(1, Number(e.target.value) || 1)) })} />
                      </Field>
                    )}
                  </div>
                  {smsAvailable && r.role !== "CC" && (
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <Field label="Mobile (optional)" htmlFor={`phone-${r.key}`} hint="International format, e.g. +919876543210">
                        <Input id={`phone-${r.key}`} type="tel" value={r.phone} onChange={(e) => updateRow(r.key, { phone: e.target.value })} />
                      </Field>
                      <label className="flex items-center gap-2 self-center text-sm text-fg">
                        <Checkbox checked={r.requireSmsOtp} onChange={(e) => updateRow(r.key, { requireSmsOtp: e.target.checked })} />
                        Also require an SMS code
                      </label>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <Button variant="secondary" size="sm" disabled={rows.length >= 25} onClick={() => setRows((rs) => [...rs, { key: rowKey(), name: "", email: "", role: "SIGNER", routingOrder: rs.length + 1, phone: "", requireSmsOtp: false }])}>
              <Plus aria-hidden />
              Add recipient
            </Button>
          </CardBody>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardHeader title="Email message" description={`Sent from ${emailAccount ?? sender.email} as ${sender.name}.`} />
          <CardBody className="space-y-4">
            {!emailAccount && <Alert tone="warning" title="No sending account connected">Connect Gmail or SMTP under Sending Accounts before you send.</Alert>}
            <Field label="Request title" htmlFor="req-title" hint="Shown in the email and on the signing page.">
              <Input id="req-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="Email subject" htmlFor="req-subject" hint={`Leave empty to use "Please review and sign: ${title || "…"}".`}>
              <Input id="req-subject" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
            </Field>
            <Field label="Message to recipients" htmlFor="req-message">
              <Textarea id="req-message" rows={5} value={message} maxLength={5000} onChange={(e) => setMessage(e.target.value)} placeholder="Please review the attached agreement and sign where indicated." />
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Expires after (days)" htmlFor="req-expiry" hint={`On ${new Date(now + expiresInDays * DAY_MS).toLocaleDateString()}`}>
                <Input id="req-expiry" type="number" min={1} max={365} value={expiresInDays} onChange={(e) => setExpiresInDays(Math.min(365, Math.max(1, Number(e.target.value) || 1)))} />
              </Field>
              <Field label="Remind every (days)" htmlFor="req-remind" hint="0 turns reminders off.">
                <Input id="req-remind" type="number" min={0} max={30} value={reminderEveryDays} onChange={(e) => setReminderEveryDays(Math.min(30, Math.max(0, Number(e.target.value) || 0)))} />
              </Field>
              <Field label="Company (optional)" htmlFor="req-company">
                <Input id="req-company" value={senderCompany} maxLength={160} onChange={(e) => setSenderCompany(e.target.value)} />
              </Field>
            </div>
          </CardBody>
        </Card>
      )}

      {step === 3 && requestId && selectedDoc && (
        <Card>
          <CardHeader title="Place fields" description="Every signer needs at least one required signature field. Fields are stored relative to the page, so they land in the same spot on any screen." />
          <CardBody>
            <FieldEditor pdfUrl={`/api/documents/${selectedDoc.id}/file?version=${versionId}`} recipients={savedRecipients} fields={fields} onChange={setFields} />
          </CardBody>
        </Card>
      )}

      {step === 4 && requestId && (
        <Card>
          <CardHeader title="Review and send" description="Check the details. Once sent, the document and fields are locked." />
          <CardBody className="space-y-4">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-muted">Document</dt>
              <dd className="text-fg">
                {selectedDoc?.title} · v{selectedVersion?.version} · {selectedVersion?.pageCount} pages
              </dd>
              <dt className="text-muted">Title</dt>
              <dd className="text-fg">{title}</dd>
              <dt className="text-muted">Signing order</dt>
              <dd className="text-fg">{signingOrder === "SEQUENTIAL" ? "In order" : "All at once"}</dd>
              <dt className="text-muted">Expires</dt>
              <dd className="text-fg">{new Date(now + expiresInDays * DAY_MS).toLocaleDateString()}</dd>
              <dt className="text-muted">Reminders</dt>
              <dd className="text-fg">{reminderEveryDays ? `Every ${reminderEveryDays} day${reminderEveryDays === 1 ? "" : "s"}` : "Off"}</dd>
              <dt className="text-muted">From</dt>
              <dd className="text-fg">
                {sender.name} &lt;{emailAccount ?? sender.email}&gt;
              </dd>
            </dl>
            <ul className="divide-y divide-line rounded-md border border-line">
              {rows.map((r, i) => (
                <li key={r.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: RECIPIENT_COLORS[i % RECIPIENT_COLORS.length] }} aria-hidden />
                    <span className="truncate text-fg">
                      {signingOrder === "SEQUENTIAL" ? `${r.routingOrder}. ` : ""}
                      {r.name} <span className="text-muted">&lt;{r.email}&gt;</span>
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge tone={r.role === "CC" ? "neutral" : "accent"}>{r.role === "CC" ? "CC" : r.role === "APPROVER" ? "Approver" : "Signer"}</Badge>
                    {r.role !== "CC" && r.id && <span className="type-caption text-muted">{fieldCount(r.id)} field{fieldCount(r.id) === 1 ? "" : "s"}</span>}
                  </span>
                </li>
              ))}
            </ul>
            {problems.length > 0 ? (
              <Alert tone="warning" title="Fix these before sending">
                <ul className="list-disc pl-4">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Alert>
            ) : (
              <label className="flex items-start gap-2 text-sm text-fg">
                <Checkbox className="mt-0.5" checked={confirmSend} onChange={(e) => setConfirmSend(e.target.checked)} />
                I confirm the document, recipients and fields are correct. Recipients will be emailed a secure link to review and sign.
              </label>
            )}
            <p className="type-caption text-subtle">
              Field types placed: {Object.entries(FIELD_META).map(([type, meta]) => `${meta.label} ${fields.filter((f) => f.type === type).length}`).join(" · ")}
            </p>
          </CardBody>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" onClick={() => goTo(step - 1)} disabled={busy || step === 0}>
          <ChevronLeft aria-hidden />
          Back
        </Button>
        {step < 4 ? (
          <Button variant="primary" onClick={() => goTo(step + 1)} loading={busy}>
            {step === 2 ? "Save and place fields" : step === 3 ? "Save fields and review" : "Continue"}
            <ChevronRight aria-hidden />
          </Button>
        ) : (
          <Button variant="primary" onClick={send} loading={busy} disabled={!confirmSend || problems.length > 0 || !emailAccount}>
            <Send aria-hidden />
            Send for signature
          </Button>
        )}
      </div>
    </div>
  );
}
