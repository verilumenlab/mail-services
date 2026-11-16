"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BellRing, CheckCircle2, RefreshCw, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/misc";
import { Modal } from "@/components/ui/modal";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/client/api";
import { formatDateTime } from "@/lib/utils";

function message(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

export function RequestActions({ id, canRemind, canCancel, canFinalize }: { id: string; canRemind: boolean; canCancel: boolean; canFinalize: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<null | "remind" | "cancel" | "finalize">(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");

  async function run(kind: "remind" | "cancel" | "finalize") {
    setBusy(kind);
    try {
      if (kind === "remind") {
        const res = await api<{ sent: number; total: number }>(`/api/signature-requests/${id}/remind`, { method: "POST", body: {} });
        if (res.sent === res.total) toast.success(`Reminder sent to ${res.sent} signer${res.sent === 1 ? "" : "s"}.`);
        else toast.warning(`${res.sent} of ${res.total} reminders were accepted. Check the recipients below.`);
      } else if (kind === "cancel") {
        await api(`/api/signature-requests/${id}/cancel`, { method: "POST", body: { reason: reason.trim() || undefined } });
        setCancelOpen(false);
        toast.success("Request cancelled. Signing links no longer work.");
      } else {
        const res = await api<{ completed: boolean }>(`/api/signature-requests/${id}/complete`, { method: "POST", body: {} });
        if (res.completed) toast.success("Final document created and sent to everyone.");
        else toast.error("The final document could not be created yet. The error is shown on this page.");
      }
      router.refresh();
    } catch (err) {
      toast.error(message(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {canFinalize && (
        <Button variant="primary" size="sm" loading={busy === "finalize"} disabled={busy !== null} onClick={() => void run("finalize")}>
          <CheckCircle2 aria-hidden />
          Create final document
        </Button>
      )}
      {canRemind && (
        <Button variant="secondary" size="sm" loading={busy === "remind"} disabled={busy !== null} onClick={() => void run("remind")}>
          <BellRing aria-hidden />
          Send reminder
        </Button>
      )}
      {canCancel && (
        <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => setCancelOpen(true)}>
          <XCircle aria-hidden />
          Cancel request
        </Button>
      )}
      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel this signing request?"
        description="Every signing link stops working immediately and recipients who were emailed are told. Signatures already given are kept in the audit trail."
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setCancelOpen(false)}>
              Keep request
            </Button>
            <Button variant="danger" size="sm" loading={busy === "cancel"} onClick={() => void run("cancel")}>
              Cancel request
            </Button>
          </>
        }
      >
        <Field label="Reason (optional)" hint="Included in the email to recipients.">
          <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Modal>
    </>
  );
}

export function ResendLinkButton({ requestId, recipientId, name }: { requestId: string; recipientId: string; name: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      size="xs"
      loading={busy}
      onClick={async () => {
        if (!window.confirm(`Send ${name} a new link? Their previous link will stop working.`)) return;
        setBusy(true);
        try {
          const res = await api<{ ok: boolean; error?: string }>(`/api/signature-requests/${requestId}/resend`, { method: "POST", body: { recipientId } });
          if (res.ok) toast.success(`New link emailed to ${name}.`);
          else toast.error(res.error ?? "The email could not be sent.");
          router.refresh();
        } catch (err) {
          toast.error(message(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <RefreshCw aria-hidden />
      Resend link
    </Button>
  );
}

export interface TimelineEvent {
  id: string;
  type: string;
  message: string;
  ip: string | null;
  createdAt: string;
}

interface AuditEntry {
  id: string;
  action: string;
  actor: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  hash: string;
}

type Integrity = { ok: true } | { ok: false; brokenAt: string; reason: string };

const EVENT_TONE: Record<string, string> = {
  REQUEST_COMPLETED: "bg-success",
  SIGNED: "bg-success",
  REQUEST_REJECTED: "bg-danger",
  REJECTED: "bg-danger",
  DELIVERY_FAILED: "bg-danger",
  FINALIZE_FAILED: "bg-danger",
  REQUEST_EXPIRED: "bg-warning",
  REQUEST_CANCELLED: "bg-subtle",
};

function eventLabel(type: string): string {
  return type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, " ");
}

export function RequestActivity({ requestId, events }: { requestId: string; events: TimelineEvent[] }) {
  const [tab, setTab] = useState<"timeline" | "audit">("timeline");
  const [audit, setAudit] = useState<{ entries: AuditEntry[]; integrity: Integrity } | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadAudit() {
    setLoading(true);
    setAuditError(null);
    try {
      setAudit(await api<{ entries: AuditEntry[]; integrity: Integrity }>(`/api/signature-requests/${requestId}/audit`));
    } catch (err) {
      setAuditError(message(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <Tabs
        label="Request activity"
        idBase="request-activity"
        value={tab}
        onChange={(k) => {
          setTab(k);
          if (k === "audit" && !audit && !loading) void loadAudit();
        }}
        items={[
          { key: "timeline", label: "Timeline", count: events.length },
          { key: "audit", label: "Audit trail" },
        ]}
      />
      {tab === "timeline" ? (
        <ol role="tabpanel" aria-labelledby="request-activity-tab-timeline" className="relative space-y-4 border-l border-line pl-5">
          {!events.length && <li className="type-caption text-muted">Nothing has happened yet.</li>}
          {events.map((e) => (
            <li key={e.id} className="relative">
              <span aria-hidden className={`absolute -left-[1.6rem] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-panel ${EVENT_TONE[e.type] ?? "bg-accent"}`} />
              <p className="text-sm text-fg">{e.message}</p>
              <p className="type-caption mt-0.5 text-subtle">
                {eventLabel(e.type)} · {formatDateTime(e.createdAt)}
                {e.ip ? ` · IP ${e.ip}` : ""}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <div role="tabpanel" aria-labelledby="request-activity-tab-audit" className="space-y-3">
          {loading && <p className="type-caption text-muted">Loading and verifying the audit trail…</p>}
          {auditError && (
            <Alert tone="danger" action={<Button size="xs" variant="outline" onClick={() => void loadAudit()}>Retry</Button>}>
              {auditError}
            </Alert>
          )}
          {audit && (
            <>
              {audit.integrity.ok ? (
                <Alert tone="success" title="Audit trail intact">
                  <span className="inline-flex items-center gap-1.5">
                    <ShieldCheck className="h-4 w-4" aria-hidden />
                    All {audit.entries.length} entries are chained by SHA-256 and none has been altered or removed.
                  </span>
                </Alert>
              ) : (
                <Alert tone="danger" title="Audit trail integrity check failed">
                  <span className="inline-flex items-center gap-1.5">
                    <ShieldAlert className="h-4 w-4" aria-hidden />
                    {audit.integrity.reason} (entry {audit.integrity.brokenAt})
                  </span>
                </Alert>
              )}
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-line bg-panel-2 text-muted">
                    <tr>
                      <th className="px-3 py-2 font-medium">Time</th>
                      <th className="px-3 py-2 font-medium">Action</th>
                      <th className="px-3 py-2 font-medium">Actor</th>
                      <th className="px-3 py-2 font-medium">IP</th>
                      <th className="px-3 py-2 font-medium">Hash</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {audit.entries.map((a) => (
                      <tr key={a.id}>
                        <td className="whitespace-nowrap px-3 py-2 text-muted">{formatDateTime(a.createdAt)}</td>
                        <td className="px-3 py-2 text-fg">{eventLabel(a.action)}</td>
                        <td className="max-w-[16rem] truncate px-3 py-2 text-muted" title={a.userAgent ?? undefined}>
                          {a.actor}
                        </td>
                        <td className="type-data px-3 py-2 text-muted">{a.ip ?? "—"}</td>
                        <td className="type-data px-3 py-2 text-subtle" title={a.hash}>
                          {a.hash.slice(0, 10)}…
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
