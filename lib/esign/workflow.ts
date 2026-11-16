import "server-only";
import { encryptSecret, decryptSecret } from "@/lib/crypto/tokens";
import { db, Prisma } from "@/lib/database/prisma";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { getActiveEmailAccount } from "@/lib/services/providers";
import { recordEvent, recordEventNow, type Actor } from "./audit";
import { cancelledEmail, invitationEmail, rejectedNoticeEmail, senderNoticeEmail, type SenderNotice } from "./email-template";
import { deliver, requestContext } from "./notify";
import { readinessProblems } from "./requests";
import { activeSigners, deriveRequestStatus, isTerminalRequest, type RequestStatus } from "./status";
import { getFile } from "./storage";
import { hashLinkToken, newLinkToken, signingLink } from "./tokens";

export const SYSTEM: Actor = { actor: "system" };

const workflowInclude = {
  recipients: { orderBy: [{ routingOrder: "asc" }, { createdAt: "asc" }] },
  fields: { orderBy: [{ page: "asc" }, { y: "asc" }] },
  version: { include: { document: { select: { id: true, title: true } } } },
} satisfies Prisma.SignatureRequestInclude;

export type WorkflowRequest = Prisma.SignatureRequestGetPayload<{ include: typeof workflowInclude }>;
export type WorkflowRecipient = WorkflowRequest["recipients"][number];

export async function loadRequest(id: string): Promise<WorkflowRequest> {
  const req = await db().signatureRequest.findUnique({ where: { id }, include: workflowInclude });
  if (!req) throw new AppError("NOT_FOUND", "Signing request not found.");
  return req;
}

export function requestUrl(id: string): string {
  return `${env().APP_URL}/esign/requests/${id}`;
}

/** Recomputes the request status from its recipients. Returns the new status. */
export async function syncRequestStatus(tx: Prisma.TransactionClient, requestId: string): Promise<RequestStatus> {
  const req = await tx.signatureRequest.findUniqueOrThrow({ where: { id: requestId }, select: { status: true, recipients: { select: { id: true, role: true, routingOrder: true, status: true } } } });
  const next = deriveRequestStatus(req.status, req.recipients);
  if (next !== req.status) await tx.signatureRequest.update({ where: { id: requestId }, data: { status: next } });
  return next;
}

export async function notifySender(
  req: WorkflowRequest,
  kind: SenderNotice,
  info: { who?: string; reason?: string | null; signed?: number; total?: number },
  notificationId?: string,
) {
  const content = senderNoticeEmail(requestContext(req), kind, { ...info, detailsUrl: requestUrl(req.id) });
  const map = { VIEWED: "VIEWED", PARTIALLY_SIGNED: "PARTIALLY_SIGNED", REJECTED: "REJECTED", EXPIRED: "EXPIRED", DELIVERY_FAILED: "DELIVERY_FAILED" } as const;
  return deliver({ userId: req.userId, requestId: req.id, kind: map[kind], to: req.senderEmail, fromName: req.senderName, content, notificationId });
}

/**
 * Emails one recipient their personal link. A first invitation (or an explicit resend) issues a new token
 * and revokes the old one; reminders reuse the current token so earlier emails keep working.
 */
export async function inviteRecipient(
  req: WorkflowRequest,
  recipient: WorkflowRecipient,
  opts: { reminder?: boolean; newToken?: boolean; actor?: Actor; notificationId?: string } = {},
) {
  const actor = opts.actor ?? SYSTEM;
  let token: string | null = null;
  if ((opts.reminder || opts.notificationId) && recipient.tokenEnc && !recipient.tokenRevokedAt && !opts.newToken) {
    try {
      token = decryptSecret(recipient.tokenEnc);
    } catch {
      token = null;
    }
  }
  if (!token) {
    token = newLinkToken();
    await db().signatureRecipient.update({
      where: { id: recipient.id },
      data: { tokenHash: hashLinkToken(token), tokenEnc: encryptSecret(token), tokenRevokedAt: null, signingSessionHash: null, signingSessionUntil: null },
    });
  }
  const content = invitationEmail(requestContext(req), recipient, signingLink(env().APP_URL, token), { reminder: opts.reminder, customSubject: req.subject });
  const result = await deliver({
    userId: req.userId,
    requestId: req.id,
    recipientId: recipient.id,
    kind: opts.reminder ? "REMINDER" : "INVITATION",
    to: recipient.email,
    fromName: req.senderName,
    content,
    notificationId: opts.notificationId,
  });
  const now = new Date();
  await db().$transaction(async (tx) => {
    if (result.ok) {
      const current = await tx.signatureRecipient.findUniqueOrThrow({ where: { id: recipient.id }, select: { status: true } });
      const progressed = ["VIEWED", "IN_REVIEW", "SIGNED", "REJECTED", "EXPIRED", "CANCELLED"].includes(current.status);
      await tx.signatureRecipient.update({
        where: { id: recipient.id },
        data: {
          ...(progressed ? {} : { status: "DELIVERED" as const }),
          ...(opts.reminder ? { lastReminderAt: now } : { sentAt: recipient.sentAt ?? now, deliveredAt: now }),
        },
      });
    } else if (recipient.status === "WAITING") {
      await tx.signatureRecipient.update({ where: { id: recipient.id }, data: { status: "SENT", sentAt: recipient.sentAt ?? now } });
    } else if (opts.reminder) {
      await tx.signatureRecipient.update({ where: { id: recipient.id }, data: { lastReminderAt: now } });
    }
    await recordEvent(tx, {
      ...actor,
      requestId: req.id,
      userId: req.userId,
      recipientId: recipient.id,
      type: result.ok ? (opts.reminder ? "REMINDER_SENT" : "INVITATION_SENT") : "DELIVERY_FAILED",
      message: result.ok
        ? `${opts.reminder ? "Reminder" : "Review Document email"} accepted by the email provider for ${recipient.email}`
        : `Email to ${recipient.email} failed: ${result.error}`,
      metadata: { notificationId: result.notificationId, kind: opts.reminder ? "REMINDER" : "INVITATION" },
    });
    await syncRequestStatus(tx, req.id);
  });
  if (!result.ok && !opts.notificationId) await notifySender(req, "DELIVERY_FAILED", { who: recipient.email, reason: result.error });
  return result;
}

/** Emails every signer whose turn it is and who has not been emailed yet. */
export async function dispatchTurn(requestId: string, actor: Actor = SYSTEM) {
  const req = await loadRequest(requestId);
  if (isTerminalRequest(req.status) || req.status === "DRAFT" || req.status === "PENDING") return;
  const due = activeSigners(req.signingOrder, req.recipients).filter((r) => r.status === "WAITING");
  for (const r of due) await inviteRecipient(req, r, { actor });
}

export async function sendRequest(userId: string, id: string, actor: Actor) {
  const req = await loadRequest(id);
  if (req.userId !== userId) throw new AppError("NOT_FOUND", "Signing request not found.");
  const problems = readinessProblems(req);
  if (problems.length) throw new AppError("VALIDATION", problems.join(" "), problems.map((message) => ({ path: "request", message })));
  if (!(await getActiveEmailAccount(userId))) throw new AppError("NOT_CONFIGURED", "Connect a sending account (Gmail or SMTP) before sending.");
  await getFile(req.version.pdfKey, req.version.pdfSha256);
  await db().$transaction(async (tx) => {
    const claimed = await tx.signatureRequest.updateMany({
      where: { id, userId, status: "DRAFT" },
      data: { status: "SENT", sentAt: new Date(), documentSha256: req.version.pdfSha256 },
    });
    if (claimed.count !== 1) throw new AppError("CONFLICT", "This request was already sent.");
    await recordEvent(tx, {
      ...actor,
      requestId: id,
      userId,
      type: "REQUEST_SENT",
      message: `Sent for signature (${req.signingOrder === "SEQUENTIAL" ? "in order" : "all at once"}) to ${req.recipients.filter((r) => r.role !== "CC").length} signer(s)`,
      metadata: { documentSha256: req.version.pdfSha256, expiresAt: req.expiresAt.toISOString(), recipients: req.recipients.map((r) => ({ email: r.email, role: r.role, order: r.routingOrder })) },
    });
  });
  await dispatchTurn(id, actor);
}

async function ownedOpenRequest(userId: string, id: string) {
  const req = await loadRequest(id);
  if (req.userId !== userId) throw new AppError("NOT_FOUND", "Signing request not found.");
  if (isTerminalRequest(req.status) || req.status === "DRAFT") throw new AppError("INVALID_STATE", "This request is not waiting for signatures.");
  return req;
}

export async function cancelRequest(userId: string, id: string, reason: string | null, actor: Actor) {
  const req = await ownedOpenRequest(userId, id);
  const now = new Date();
  await db().$transaction(async (tx) => {
    const claimed = await tx.signatureRequest.updateMany({ where: { id, status: req.status }, data: { status: "CANCELLED", cancelledAt: now } });
    if (claimed.count !== 1) throw new AppError("CONFLICT", "The request changed while cancelling. Reload and try again.");
    await tx.signatureRecipient.updateMany({ where: { requestId: id, status: { notIn: ["SIGNED", "REJECTED"] } }, data: { status: "CANCELLED", tokenRevokedAt: now } });
    await tx.signatureRecipient.updateMany({ where: { requestId: id, tokenRevokedAt: null }, data: { tokenRevokedAt: now } });
    await recordEvent(tx, { ...actor, requestId: id, userId, type: "REQUEST_CANCELLED", message: reason ? `Cancelled by the sender: ${reason}` : "Cancelled by the sender", metadata: { reason } });
  });
  const ctx = requestContext(req);
  for (const r of req.recipients.filter((x) => x.sentAt && x.role !== "CC")) {
    await deliver({ userId, requestId: id, recipientId: r.id, kind: "CANCELLED", to: r.email, fromName: req.senderName, content: cancelledEmail(ctx, r, reason) });
  }
}

export async function remindNow(userId: string, id: string, actor: Actor) {
  const req = await ownedOpenRequest(userId, id);
  if (req.status === "PENDING") throw new AppError("INVALID_STATE", "Everyone has signed; the document is being finalised.");
  const due = activeSigners(req.signingOrder, req.recipients).filter((r) => r.status !== "WAITING" || r.sentAt);
  if (!due.length) throw new AppError("INVALID_STATE", "Nobody is waiting to sign right now.");
  let sent = 0;
  for (const r of due) if ((await inviteRecipient(req, r, { reminder: true, actor })).ok) sent += 1;
  return { sent, total: due.length };
}

/** New link for one recipient (the old link stops working), e.g. after a delivery failure. */
export async function resendInvitation(userId: string, id: string, recipientId: string, actor: Actor) {
  const req = await ownedOpenRequest(userId, id);
  const r = req.recipients.find((x) => x.id === recipientId);
  if (!r || r.role === "CC") throw new AppError("NOT_FOUND", "Recipient not found.");
  if (!activeSigners(req.signingOrder, req.recipients).some((x) => x.id === r.id)) throw new AppError("INVALID_STATE", `It is not ${r.name}'s turn to sign yet.`);
  await recordEventNow({ ...actor, requestId: id, userId, recipientId: r.id, type: "LINK_REISSUED", message: `Previous link for ${r.email} revoked and a new one issued` });
  return inviteRecipient(req, r, { newToken: true, actor });
}

/** Tells the other parties a request was closed because someone declined. */
export async function notifyRejected(req: WorkflowRequest, rejecter: WorkflowRecipient) {
  await notifySender(req, "REJECTED", { who: `${rejecter.name} (${rejecter.email})`, reason: rejecter.rejectReason });
  const ctx = requestContext(req);
  for (const r of req.recipients.filter((x) => x.id !== rejecter.id && x.sentAt && x.role !== "CC")) {
    await deliver({ userId: req.userId, requestId: req.id, recipientId: r.id, kind: "REJECTED", to: r.email, fromName: req.senderName, content: rejectedNoticeEmail(ctx, r, rejecter.name) });
  }
}
