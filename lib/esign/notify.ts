import "server-only";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/database/prisma";
import { providerForAccount } from "@/lib/email";
import { ProviderError, describeProviderError } from "@/lib/email/provider";
import { env } from "@/lib/env";
import { errorMessage } from "@/lib/errors";
import type { NotificationKind } from "@/lib/generated/prisma/client";
import { getActiveEmailAccount } from "@/lib/services/providers";
import type { EmailContent, RequestContext } from "./email-template";

export const MAX_NOTIFICATION_ATTEMPTS = 5;

export function requestContext(req: {
  title: string;
  senderName: string;
  senderEmail: string;
  senderCompany: string | null;
  message: string | null;
  expiresAt: Date;
  version: { document: { title: string } };
}): RequestContext {
  return {
    appUrl: env().APP_URL,
    title: req.title,
    documentTitle: req.version.document.title,
    senderName: req.senderName,
    senderEmail: req.senderEmail,
    senderCompany: req.senderCompany,
    message: req.message,
    expiresAt: req.expiresAt,
  };
}

export interface DeliverInput {
  userId: string;
  requestId: string;
  recipientId?: string | null;
  kind: NotificationKind;
  to: string;
  fromName: string;
  content: EmailContent;
  attachments?: { filename: string; contentType: string; content: Buffer }[];
  /** Retry an existing notification row instead of creating a new one. */
  notificationId?: string;
}

/** Writes outgoing e-sign mail to ESIGN_DEV_OUTBOX for local end-to-end tests. Never active in production. */
async function devOutbox(input: DeliverInput) {
  const dir = process.env.ESIGN_DEV_OUTBOX?.trim();
  if (!dir || env().isProduction) return;
  await mkdir(dir, { recursive: true });
  const name = `${Date.now()}-${input.kind}-${input.to.replace(/[^a-z0-9@._-]/gi, "_")}.json`;
  await writeFile(path.join(dir, name), JSON.stringify({ to: input.to, kind: input.kind, subject: input.content.subject, text: input.content.text, attachments: (input.attachments ?? []).map((a) => a.filename) }, null, 2));
}

function backoffMs(attempts: number): number {
  return Math.min(6 * 60 * 60 * 1000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/** Sends one e-sign email through the sender's connected account and records the outcome. */
export async function deliver(input: DeliverInput): Promise<{ ok: boolean; error?: string; notificationId: string }> {
  const row = input.notificationId
    ? await db().emailNotification.update({ where: { id: input.notificationId }, data: { status: "QUEUED" } })
    : await db().emailNotification.create({
        data: { requestId: input.requestId, recipientId: input.recipientId ?? null, kind: input.kind, toEmail: input.to, subject: input.content.subject.slice(0, 300) },
      });
  const attempts = row.attempts + 1;
  try {
    const account = await getActiveEmailAccount(input.userId);
    if (!account) throw new ProviderError("AUTH", "No sending account is connected. Connect Gmail or SMTP under Sending Accounts.");
    const result = await providerForAccount(account).sendEmail({
      from: { email: account.email, name: input.fromName },
      to: input.to,
      subject: input.content.subject,
      body: input.content.text,
      html: input.content.html,
      attachments: input.attachments,
    });
    await devOutbox(input).catch((err) => console.warn("[esign] dev outbox write failed", errorMessage(err)));
    await db().emailNotification.update({
      where: { id: row.id },
      data: { status: "SENT", attempts, sentAt: new Date(), providerMessageId: result.providerMessageId, lastError: null, nextAttemptAt: null },
    });
    return { ok: true, notificationId: row.id };
  } catch (err) {
    const message = err instanceof ProviderError ? describeProviderError(err) : errorMessage(err);
    // A one-time code is only useful for minutes; the signer asks for a new one instead.
    const retryable = input.kind !== "OTP" && !(err instanceof ProviderError && err.kind === "INVALID_RECIPIENT") && attempts < MAX_NOTIFICATION_ATTEMPTS;
    await db().emailNotification.update({
      where: { id: row.id },
      data: { status: "FAILED", attempts, lastError: message.slice(0, 1000), nextAttemptAt: retryable ? new Date(Date.now() + backoffMs(attempts)) : null },
    });
    console.warn(`[esign] ${input.kind} email to ${input.to} failed: ${message}`);
    return { ok: false, error: message, notificationId: row.id };
  }
}
