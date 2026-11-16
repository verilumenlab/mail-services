import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AlertTriangle, Download, FileCheck2 } from "lucide-react";
import { DocumentPreview } from "@/components/esign/document-preview";
import { RequestActions, RequestActivity, ResendLinkButton } from "@/components/esign/request-actions";
import { RequestStatusBadge, SignerStatusBadge, formatBytes, shortHash } from "@/components/esign/request-status";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert, PageHeader } from "@/components/ui/misc";
import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/database/prisma";
import { signatureLevelLabel } from "@/lib/esign/consent";
import { MAX_FINALIZE_ATTEMPTS } from "@/lib/esign/finalize";
import { OPEN_REQUEST, activeSigners } from "@/lib/esign/status";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Signing request · E-Signature" };

const ROLE_LABEL: Record<string, string> = { SIGNER: "Signer", APPROVER: "Approver", CC: "Receives a copy" };

export default async function RequestPage({ params }: PageProps<"/esign/requests/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  const req = await db().signatureRequest.findFirst({
    where: { id, userId: user.id },
    include: {
      recipients: { orderBy: [{ routingOrder: "asc" }, { createdAt: "asc" }] },
      version: { include: { document: { select: { id: true, title: true } } } },
      certificate: true,
      events: { orderBy: { createdAt: "asc" } },
      notifications: { where: { status: "FAILED" }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!req) notFound();
  if (req.status === "DRAFT") redirect(`/esign/requests/${req.id}/edit`);

  const open = (OPEN_REQUEST as readonly string[]).includes(req.status);
  const active = open ? activeSigners(req.signingOrder, req.recipients) : [];
  const activeIds = new Set(active.map((r) => r.id));
  const signers = req.recipients.filter((r) => r.role !== "CC");
  const signed = signers.filter((r) => r.status === "SIGNED").length;
  const failedFor = new Map<string, string>();
  for (const n of req.notifications) if (n.recipientId && n.lastError && !failedFor.has(n.recipientId)) failedFor.set(n.recipientId, n.lastError);
  const download = (file: string) => `/api/signature-requests/${req.id}/download?file=${file}`;

  return (
    <>
      <PageHeader
        eyebrow="E-Signature · Signing request"
        title={req.title}
        description={
          <>
            <Link href={`/esign/documents/${req.version.document.id}`} className="hover:text-accent-strong hover:underline">
              {req.version.document.title}
            </Link>{" "}
            v{req.version.version} · {signed} of {signers.length} signed
          </>
        }
        actions={
          <>
            <RequestStatusBadge status={req.status} />
            <RequestActions
              id={req.id}
              canRemind={open && active.some((r) => r.sentAt)}
              canCancel={open}
              canFinalize={req.status === "PENDING"}
            />
          </>
        }
      />

      <div className="space-y-6">
        {req.status === "PENDING" && (
          <Alert tone={req.finalizeError ? "warning" : "info"} title={req.finalizeError ? "The final document could not be created yet" : "Creating the final document"}>
            {req.finalizeError
              ? `${req.finalizeError} It is retried automatically (${req.finalizeAttempts} of ${MAX_FINALIZE_ATTEMPTS} attempts); you can also retry now.`
              : "Everyone has signed. The signed PDF and completion certificate are being generated and will be emailed to all parties."}
          </Alert>
        )}
        {req.status === "REJECTED" && (
          <Alert tone="danger" title="Declined">
            {req.recipients
              .filter((r) => r.status === "REJECTED")
              .map((r) => `${r.name} declined${r.rejectReason ? `: “${r.rejectReason}”` : "."}`)
              .join(" ")}
          </Alert>
        )}
        {req.status === "COMPLETED" && (
          <Alert
            tone="success"
            title="Completed"
            action={
              <div className="flex flex-wrap gap-2">
                <a href={download("final")} className={buttonClasses({ variant: "primary", size: "sm" })}>
                  <Download aria-hidden />
                  Signed PDF
                </a>
                <a href={download("certificate")} className={buttonClasses({ variant: "outline", size: "sm" })}>
                  <FileCheck2 aria-hidden />
                  Certificate
                </a>
              </div>
            }
          >
            Signed by everyone on {req.completedAt ? formatDateTime(req.completedAt) : "—"}. A copy was emailed to every party.
          </Alert>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="min-w-0 space-y-6">
            <Card>
              <CardHeader title="Recipients" description={req.signingOrder === "SEQUENTIAL" ? "Signing in order: each signer is emailed when the previous one finishes." : "All signers were emailed at the same time."} />
              <CardBody className="p-0">
                <ul className="divide-y divide-line">
                  {req.recipients.map((r) => {
                    const failed = failedFor.get(r.id);
                    return (
                      <li key={r.id} className="space-y-2 px-5 py-4">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-fg">
                              {req.signingOrder === "SEQUENTIAL" && r.role !== "CC" && <span className="type-data mr-1.5 text-subtle">{r.routingOrder}.</span>}
                              {r.name}
                              {activeIds.has(r.id) && (
                                <Badge tone="accent" className="ml-2">
                                  Their turn
                                </Badge>
                              )}
                            </p>
                            <p className="type-caption break-all text-muted">
                              {r.email} · {ROLE_LABEL[r.role] ?? r.role}
                              {r.requireSmsOtp && r.phone ? " · SMS code required" : ""}
                            </p>
                          </div>
                          <SignerStatusBadge status={r.status} role={r.role} />
                        </div>
                        <dl className="type-caption grid grid-cols-2 gap-x-4 gap-y-1 text-muted sm:grid-cols-3">
                          {(
                            [
                              ["Emailed", r.sentAt],
                              ["Opened", r.viewedAt],
                              ["Reviewed", r.reviewedAt],
                              ["Consented", r.consentAt],
                              ["Email verified", r.emailVerifiedAt],
                              ["Signed", r.signedAt],
                              ["Declined", r.rejectedAt],
                              ["Last reminder", r.lastReminderAt],
                            ] as const
                          )
                            .filter(([, at]) => at)
                            .map(([label, at]) => (
                              <div key={label}>
                                <dt className="text-subtle">{label}</dt>
                                <dd>{formatDateTime(at!)}</dd>
                              </div>
                            ))}
                        </dl>
                        {failed && r.status !== "SIGNED" && (
                          <p className="type-caption flex items-start gap-1.5 text-danger">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                            Last email failed: {failed}
                          </p>
                        )}
                        {activeIds.has(r.id) && (
                          <ResendLinkButton requestId={req.id} recipientId={r.id} name={r.name} />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Activity" description="Timeline of what happened, and the tamper-evident audit trail." />
              <CardBody>
                <RequestActivity
                  requestId={req.id}
                  events={req.events.map((e) => ({ id: e.id, type: e.type, message: e.message, ip: e.ip, createdAt: e.createdAt.toISOString() }))}
                />
              </CardBody>
            </Card>
          </div>

          <div className="min-w-0 space-y-6">
            <Card>
              <CardHeader title="Details" />
              <CardBody>
                <dl className="space-y-3 text-sm">
                  {(
                    [
                      ["Sent", req.sentAt ? formatDateTime(req.sentAt) : "—"],
                      ["Expires", formatDateTime(req.expiresAt)],
                      ["Reminders", req.reminderEveryDays ? `Every ${req.reminderEveryDays} day${req.reminderEveryDays === 1 ? "" : "s"}` : "Off"],
                      ["From", `${req.senderName} <${req.senderEmail}>`],
                      ["Subject", req.subject],
                      ["Signature type", signatureLevelLabel(req.signatureLevel)],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label}>
                      <dt className="type-caption text-subtle">{label}</dt>
                      <dd className="break-words text-fg">{value}</dd>
                    </div>
                  ))}
                  {req.cancelledAt && (
                    <div>
                      <dt className="type-caption text-subtle">Cancelled</dt>
                      <dd className="text-fg">{formatDateTime(req.cancelledAt)}</dd>
                    </div>
                  )}
                  {req.expiredAt && (
                    <div>
                      <dt className="type-caption text-subtle">Expired</dt>
                      <dd className="text-fg">{formatDateTime(req.expiredAt)}</dd>
                    </div>
                  )}
                </dl>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Integrity" description="SHA-256 fingerprints. Any change to a file changes its hash." />
              <CardBody>
                <dl className="type-data space-y-3 text-[11px]">
                  <div>
                    <dt className="font-sans text-xs text-subtle">Document sent for signature</dt>
                    <dd className="break-all text-muted" title={req.documentSha256 ?? undefined}>
                      {req.documentSha256 ?? "—"}
                    </dd>
                  </div>
                  {req.finalSha256 && (
                    <div>
                      <dt className="font-sans text-xs text-subtle">Signed PDF{req.finalSize ? ` (${formatBytes(req.finalSize)})` : ""}</dt>
                      <dd className="break-all text-muted">{req.finalSha256}</dd>
                    </div>
                  )}
                  {req.certificate && (
                    <div>
                      <dt className="font-sans text-xs text-subtle">Completion certificate</dt>
                      <dd className="break-all text-muted" title={req.certificate.sha256}>
                        {shortHash(req.certificate.sha256)}
                      </dd>
                    </div>
                  )}
                </dl>
                <a href={download("original")} className={buttonClasses({ variant: "ghost", size: "xs", className: "mt-4" })}>
                  <Download aria-hidden />
                  Original PDF
                </a>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Document" />
              <CardBody>
                <DocumentPreview src={`/api/documents/${req.version.document.id}/file?version=${req.version.id}`} />
              </CardBody>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
