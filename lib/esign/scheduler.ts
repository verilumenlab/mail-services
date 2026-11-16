import "server-only";
import { db } from "@/lib/database/prisma";
import { errorMessage } from "@/lib/errors";
import { recordEvent } from "./audit";
import { cancelledEmail, rejectedNoticeEmail } from "./email-template";
import { MAX_FINALIZE_ATTEMPTS, finalizeRequest, sendCompletedEmails } from "./finalize";
import { MAX_NOTIFICATION_ATTEMPTS, deliver, requestContext } from "./notify";
import { OPEN_REQUEST, activeSigners } from "./status";
import { SYSTEM, dispatchTurn, inviteRecipient, loadRequest, notifySender, syncRequestStatus } from "./workflow";

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 25;
/** A signer's own request may still be finalising; leave it alone for a while before retrying. */
const FINALIZE_RETRY_AFTER_MS = 2 * 60 * 1000;
/** Signers whose turn came while an earlier dispatch crashed are invited after this grace period. */
const DISPATCH_GRACE_MS = 60 * 1000;

/** Closes requests past their expiry date: links stop working and the sender is told. */
export async function expireDue(now = new Date()): Promise<number> {
  const due = await db().signatureRequest.findMany({
    where: { status: { in: [...OPEN_REQUEST] }, expiresAt: { lte: now } },
    select: { id: true },
    take: BATCH,
  });
  let expired = 0;
  for (const { id } of due) {
    const changed = await db().$transaction(async (tx) => {
      const claimed = await tx.signatureRequest.updateMany({ where: { id, status: { in: [...OPEN_REQUEST] } }, data: { status: "EXPIRED", expiredAt: now } });
      if (claimed.count !== 1) return null;
      const req = await tx.signatureRequest.findUniqueOrThrow({ where: { id }, select: { userId: true, expiresAt: true } });
      await tx.signatureRecipient.updateMany({ where: { requestId: id, status: { notIn: ["SIGNED", "REJECTED", "CANCELLED"] } }, data: { status: "EXPIRED" } });
      await tx.signatureRecipient.updateMany({ where: { requestId: id, tokenRevokedAt: null }, data: { tokenRevokedAt: now } });
      await recordEvent(tx, { ...SYSTEM, requestId: id, userId: req.userId, type: "REQUEST_EXPIRED", message: `Expired unsigned on ${req.expiresAt.toISOString()}` });
      return req;
    });
    if (!changed) continue;
    expired += 1;
    const req = await loadRequest(id);
    const pending = req.recipients.filter((r) => r.role !== "CC" && r.status !== "SIGNED").map((r) => r.email);
    await notifySender(req, "EXPIRED", { who: pending.join(", ") || undefined });
  }
  return expired;
}

/** Sends automatic reminders every `reminderEveryDays` to signers whose turn it is, and repairs missed invitations. */
export async function remindDue(now = new Date()): Promise<number> {
  const open = await db().signatureRequest.findMany({
    where: { status: { in: [...OPEN_REQUEST] }, expiresAt: { gt: now } },
    select: { id: true, reminderEveryDays: true, sentAt: true, signingOrder: true, recipients: { select: { id: true, role: true, routingOrder: true, status: true, sentAt: true, lastReminderAt: true } } },
    orderBy: { updatedAt: "asc" },
    take: 200,
  });
  let reminded = 0;
  for (const req of open) {
    const active = activeSigners(req.signingOrder, req.recipients);
    if (active.some((r) => r.status === "WAITING" && !r.sentAt) && req.sentAt && now.getTime() - req.sentAt.getTime() > DISPATCH_GRACE_MS) {
      await dispatchTurn(req.id);
    }
    if (req.reminderEveryDays <= 0) continue;
    const every = req.reminderEveryDays * DAY_MS;
    const due = active.filter((r) => {
      const since = r.lastReminderAt ?? r.sentAt;
      return since && now.getTime() - since.getTime() >= every;
    });
    if (!due.length) continue;
    const full = await loadRequest(req.id);
    for (const d of due) {
      const r = full.recipients.find((x) => x.id === d.id);
      if (!r) continue;
      if ((await inviteRecipient(full, r, { reminder: true })).ok) reminded += 1;
      if (reminded >= BATCH) return reminded;
    }
  }
  return reminded;
}

/** Retries e-sign emails that failed with a temporary error, rebuilding their content from current state. */
export async function retryNotifications(now = new Date()): Promise<number> {
  const failed = await db().emailNotification.findMany({
    where: { status: "FAILED", nextAttemptAt: { lte: now }, attempts: { lt: MAX_NOTIFICATION_ATTEMPTS }, kind: { not: "OTP" } },
    orderBy: { nextAttemptAt: "asc" },
    take: BATCH,
  });
  let retried = 0;
  for (const n of failed) {
    const claimed = await db().emailNotification.updateMany({ where: { id: n.id, status: "FAILED", nextAttemptAt: n.nextAttemptAt }, data: { nextAttemptAt: null } });
    if (claimed.count !== 1) continue;
    try {
      if (await retryOne(n)) retried += 1;
    } catch (err) {
      console.warn(`[esign] retry of notification ${n.id} failed:`, errorMessage(err));
    }
  }
  return retried;
}

async function retryOne(n: { id: string; requestId: string; recipientId: string | null; kind: string; toEmail: string }): Promise<boolean> {
  const req = await loadRequest(n.requestId);
  const recipient = n.recipientId ? req.recipients.find((r) => r.id === n.recipientId) : undefined;
  const open = (OPEN_REQUEST as readonly string[]).includes(req.status);
  const ctx = requestContext(req);
  const base = { userId: req.userId, requestId: req.id, recipientId: n.recipientId, to: n.toEmail, fromName: req.senderName, notificationId: n.id };

  switch (n.kind) {
    case "INVITATION":
    case "REMINDER": {
      // Only worth sending while this person can still act on the link.
      if (!open || !recipient || !activeSigners(req.signingOrder, req.recipients).some((r) => r.id === recipient.id)) return false;
      return (await inviteRecipient(req, recipient, { reminder: n.kind === "REMINDER", notificationId: n.id })).ok;
    }
    case "COMPLETED":
      if (req.status !== "COMPLETED") return false;
      await sendCompletedEmails(req, { notificationId: n.id, to: n.toEmail, recipientId: n.recipientId });
      return true;
    case "CANCELLED": {
      if (req.status !== "CANCELLED" || !recipient) return false;
      const event = await db().signatureEvent.findFirst({ where: { requestId: req.id, type: "REQUEST_CANCELLED" }, orderBy: { createdAt: "desc" } });
      const reason = (event?.metadata as { reason?: string | null } | null)?.reason ?? null;
      return (await deliver({ ...base, kind: "CANCELLED", content: cancelledEmail(ctx, recipient, reason) })).ok;
    }
    case "REJECTED": {
      if (req.status !== "REJECTED") return false;
      const rejecter = req.recipients.find((r) => r.status === "REJECTED");
      if (!rejecter) return false;
      if (recipient) return (await deliver({ ...base, kind: "REJECTED", content: rejectedNoticeEmail(ctx, recipient, rejecter.name) })).ok;
      return (await notifySender(req, "REJECTED", { who: `${rejecter.name} (${rejecter.email})`, reason: rejecter.rejectReason }, n.id)).ok;
    }
    case "EXPIRED": {
      if (req.status !== "EXPIRED") return false;
      const pending = req.recipients.filter((r) => r.role !== "CC" && r.status !== "SIGNED").map((r) => r.email);
      return (await notifySender(req, "EXPIRED", { who: pending.join(", ") || undefined }, n.id)).ok;
    }
    case "PARTIALLY_SIGNED": {
      if (!open) return false;
      const signers = req.recipients.filter((r) => r.role !== "CC");
      const latest = signers.filter((r) => r.signedAt).sort((a, b) => b.signedAt!.getTime() - a.signedAt!.getTime())[0];
      if (!latest) return false;
      const info = { who: `${latest.name} (${latest.email})`, signed: signers.filter((r) => r.status === "SIGNED").length, total: signers.length };
      return (await notifySender(req, "PARTIALLY_SIGNED", info, n.id)).ok;
    }
    default:
      // VIEWED and DELIVERY_FAILED notices describe a moment that has passed; the request page shows them.
      return false;
  }
}

/** Finishes requests whose signers all signed but whose final PDF could not be produced yet. */
export async function finalizeDue(now = new Date()): Promise<number> {
  const due = await db().signatureRequest.findMany({
    where: { status: "PENDING", finalizeAttempts: { lt: MAX_FINALIZE_ATTEMPTS }, updatedAt: { lte: new Date(now.getTime() - FINALIZE_RETRY_AFTER_MS) } },
    select: { id: true },
    take: 5,
  });
  let done = 0;
  for (const { id } of due) if (await finalizeRequest(id)) done += 1;
  return done;
}

/** Keeps statuses honest for requests touched outside a transaction (defensive; normally a no-op). */
async function resyncStatuses() {
  const open = await db().signatureRequest.findMany({ where: { status: { in: [...OPEN_REQUEST] } }, select: { id: true }, orderBy: { updatedAt: "asc" }, take: BATCH });
  for (const { id } of open) {
    const status = await db().$transaction((tx) => syncRequestStatus(tx, id));
    if (status === "PENDING") await finalizeRequest(id);
  }
}

/** One pass of e-sign housekeeping, run by the queue worker about once a minute. */
export async function esignTick(now = new Date()): Promise<void> {
  const steps: [string, () => Promise<unknown>][] = [
    ["expire", () => expireDue(now)],
    ["remind", () => remindDue(now)],
    ["notifications", () => retryNotifications(now)],
    ["finalize", () => finalizeDue(now)],
    ["status", () => resyncStatuses()],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      console.error(`[esign] ${name} step failed:`, errorMessage(err));
    }
  }
}
