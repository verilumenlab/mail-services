import "server-only";
import { db, Prisma } from "@/lib/database/prisma";
import { AppError } from "@/lib/errors";
import { getActiveEmailAccount } from "@/lib/services/providers";
import type { FieldInput, RequestDraftInput } from "@/lib/validation/esign";
import { recordEvent, type Actor } from "./audit";
import { clampRect } from "./geometry";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function senderIdentity(userId: string): Promise<{ name: string; email: string; company: string | null }> {
  const [user, profile, account] = await Promise.all([
    db().user.findUnique({ where: { id: userId }, select: { name: true, email: true } }),
    db().senderProfile.findFirst({ where: { userId }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] }),
    getActiveEmailAccount(userId),
  ]);
  if (!user) throw new AppError("UNAUTHORIZED", "Your session has expired. Please sign in again.");
  return {
    name: profile?.senderName || account?.displayName || user.name || user.email,
    email: account?.email || user.email,
    company: profile?.companyName ?? null,
  };
}

const requestInclude = {
  recipients: { orderBy: [{ routingOrder: "asc" }, { createdAt: "asc" }] },
  fields: { orderBy: [{ page: "asc" }, { y: "asc" }] },
  version: { include: { document: { select: { id: true, title: true } } } },
} satisfies Prisma.SignatureRequestInclude;

export type RequestWithParts = Prisma.SignatureRequestGetPayload<{ include: typeof requestInclude }>;

export async function getOwnedRequest(userId: string, id: string): Promise<RequestWithParts> {
  const req = await db().signatureRequest.findFirst({ where: { id, userId }, include: requestInclude });
  if (!req) throw new AppError("NOT_FOUND", "Signing request not found.");
  return req;
}

async function ownedVersion(userId: string, versionId: string) {
  const version = await db().documentVersion.findFirst({ where: { id: versionId, document: { userId } }, include: { document: { select: { title: true } } } });
  if (!version) throw new AppError("NOT_FOUND", "Document version not found.");
  return version;
}

function recipientData(r: RequestDraftInput["recipients"][number]) {
  return {
    name: r.name,
    email: r.email,
    role: r.role,
    routingOrder: r.routingOrder,
    phone: r.phone ?? null,
    requireSmsOtp: Boolean(r.requireSmsOtp && r.phone),
  };
}

export async function createDraft(userId: string, input: RequestDraftInput, actor: Actor) {
  const version = await ownedVersion(userId, input.documentVersionId);
  const sender = await senderIdentity(userId);
  return db().$transaction(async (tx) => {
    const req = await tx.signatureRequest.create({
      data: {
        userId,
        documentVersionId: version.id,
        title: input.title,
        subject: input.subject || `Please review and sign: ${input.title}`,
        message: input.message || null,
        signingOrder: input.signingOrder,
        expiresAt: new Date(Date.now() + input.expiresInDays * DAY_MS),
        reminderEveryDays: input.reminderEveryDays,
        senderName: sender.name,
        senderEmail: sender.email,
        senderCompany: input.senderCompany || sender.company,
        recipients: { create: input.recipients.map(recipientData) },
      },
    });
    await recordEvent(tx, {
      ...actor,
      requestId: req.id,
      userId,
      type: "REQUEST_CREATED",
      message: `Draft created for ${version.document.title} (version ${version.version})`,
      metadata: { documentVersionId: version.id, recipients: input.recipients.length, signingOrder: input.signingOrder },
    });
    return req;
  });
}

/** Updates a draft. Recipients are matched by email so their placed fields survive edits. */
export async function updateDraft(userId: string, id: string, input: RequestDraftInput, actor: Actor) {
  const current = await getOwnedRequest(userId, id);
  if (current.status !== "DRAFT") throw new AppError("INVALID_STATE", "Only draft requests can be edited.");
  const version = await ownedVersion(userId, input.documentVersionId);
  return db().$transaction(async (tx) => {
    const keep = new Map(current.recipients.map((r) => [r.email, r]));
    const wanted = new Set(input.recipients.map((r) => r.email));
    const removed = current.recipients.filter((r) => !wanted.has(r.email)).map((r) => r.id);
    if (removed.length) await tx.signatureRecipient.deleteMany({ where: { requestId: id, id: { in: removed } } });
    for (const r of input.recipients) {
      const existing = keep.get(r.email);
      if (existing) await tx.signatureRecipient.update({ where: { id: existing.id }, data: recipientData(r) });
      else await tx.signatureRecipient.create({ data: { requestId: id, ...recipientData(r) } });
    }
    const ccIds = (await tx.signatureRecipient.findMany({ where: { requestId: id, role: "CC" }, select: { id: true } })).map((r) => r.id);
    if (ccIds.length) await tx.signatureField.deleteMany({ where: { requestId: id, recipientId: { in: ccIds } } });
    if (version.id !== current.documentVersionId) await tx.signatureField.deleteMany({ where: { requestId: id } });
    else await tx.signatureField.deleteMany({ where: { requestId: id, page: { gt: version.pageCount } } });
    const updated = await tx.signatureRequest.update({
      where: { id },
      data: {
        documentVersionId: version.id,
        title: input.title,
        subject: input.subject || `Please review and sign: ${input.title}`,
        message: input.message || null,
        signingOrder: input.signingOrder,
        expiresAt: new Date(Date.now() + input.expiresInDays * DAY_MS),
        reminderEveryDays: input.reminderEveryDays,
        senderCompany: input.senderCompany || current.senderCompany,
      },
    });
    await recordEvent(tx, {
      ...actor,
      requestId: id,
      userId,
      type: "REQUEST_UPDATED",
      message: "Draft updated",
      metadata: { recipients: input.recipients.length, documentVersionId: version.id, removedRecipients: removed.length },
    });
    return updated;
  });
}

/** Drafts are discarded rather than deleted: their audit rows are permanent. */
export async function discardDraft(userId: string, id: string, actor: Actor) {
  const current = await getOwnedRequest(userId, id);
  if (current.status !== "DRAFT") throw new AppError("INVALID_STATE", "Only drafts can be discarded. Cancel a sent request instead.");
  await db().$transaction(async (tx) => {
    await tx.signatureRequest.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    await recordEvent(tx, { ...actor, requestId: id, userId, type: "REQUEST_DISCARDED", message: "Draft discarded" });
  });
}

export async function replaceFields(userId: string, requestId: string, fields: FieldInput[], actor: Actor) {
  const req = await getOwnedRequest(userId, requestId);
  if (req.status !== "DRAFT") throw new AppError("INVALID_STATE", "Fields can only be changed while the request is a draft.");
  const recipients = new Map(req.recipients.map((r) => [r.id, r]));
  for (const f of fields) {
    const r = recipients.get(f.recipientId);
    if (!r) throw new AppError("VALIDATION", "A field is assigned to a recipient who is not on this request.");
    if (r.role === "CC") throw new AppError("VALIDATION", `${r.name} only receives a copy and cannot have fields.`);
    if (f.page > req.version.pageCount) throw new AppError("VALIDATION", `Page ${f.page} does not exist in this document.`);
  }
  await db().$transaction(async (tx) => {
    await tx.signatureField.deleteMany({ where: { requestId } });
    if (fields.length) {
      await tx.signatureField.createMany({
        data: fields.map((f) => ({
          requestId,
          recipientId: f.recipientId,
          type: f.type,
          page: f.page,
          ...clampRect(f),
          required: f.required,
          label: f.label || null,
        })),
      });
    }
    await recordEvent(tx, {
      ...actor,
      requestId,
      userId,
      type: "FIELDS_UPDATED",
      message: `${fields.length} field${fields.length === 1 ? "" : "s"} placed`,
      metadata: { count: fields.length },
    });
  });
}

/** Problems that block sending; empty when the request is ready. */
export function readinessProblems(req: RequestWithParts): string[] {
  const problems: string[] = [];
  if (req.status !== "DRAFT") problems.push("This request has already been sent.");
  const signers = req.recipients.filter((r) => r.role !== "CC");
  if (!signers.length) problems.push("Add at least one signer or approver.");
  for (const r of req.recipients) {
    if (r.role !== "SIGNER") continue;
    const ok = req.fields.some((f) => f.recipientId === r.id && f.type === "SIGNATURE" && f.required);
    if (!ok) problems.push(`${r.name} needs at least one required signature field.`);
  }
  if (req.expiresAt.getTime() <= Date.now()) problems.push("The expiry date is in the past.");
  return problems;
}

export function publicRequest(req: RequestWithParts) {
  return {
    id: req.id,
    title: req.title,
    subject: req.subject,
    message: req.message,
    status: req.status,
    signingOrder: req.signingOrder,
    expiresAt: req.expiresAt.toISOString(),
    reminderEveryDays: req.reminderEveryDays,
    senderName: req.senderName,
    senderEmail: req.senderEmail,
    senderCompany: req.senderCompany,
    documentSha256: req.documentSha256,
    finalSha256: req.finalSha256,
    signatureLevel: req.signatureLevel,
    finalizeError: req.finalizeError,
    sentAt: req.sentAt?.toISOString() ?? null,
    completedAt: req.completedAt?.toISOString() ?? null,
    createdAt: req.createdAt.toISOString(),
    document: { id: req.version.document.id, title: req.version.document.title, versionId: req.version.id, version: req.version.version, pageCount: req.version.pageCount },
    recipients: req.recipients.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      routingOrder: r.routingOrder,
      status: r.status,
      phone: r.phone,
      requireSmsOtp: r.requireSmsOtp,
      sentAt: r.sentAt?.toISOString() ?? null,
      viewedAt: r.viewedAt?.toISOString() ?? null,
      signedAt: r.signedAt?.toISOString() ?? null,
      rejectedAt: r.rejectedAt?.toISOString() ?? null,
      rejectReason: r.rejectReason,
    })),
    fields: req.fields.map(publicField),
  };
}

export function publicField(f: RequestWithParts["fields"][number]) {
  return { id: f.id, recipientId: f.recipientId, type: f.type, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, required: f.required, label: f.label };
}
