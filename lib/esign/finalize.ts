import "server-only";
import { db } from "@/lib/database/prisma";
import { errorMessage } from "@/lib/errors";
import { auditTrail, recordEvent, recordEventNow } from "./audit";
import { buildCertificate } from "./certificate";
import { CONSENT_TEXT, signatureLevelLabel } from "./consent";
import { completedEmail } from "./email-template";
import { pdfNameFor, safeFileName, sha256Hex } from "./files";
import { deliver, requestContext } from "./notify";
import { appendPdf, stampFields } from "./pdf";
import { configuredPdfSigner } from "./pdf-signer";
import { getFile, putFile } from "./storage";
import { loadRequest, SYSTEM, type WorkflowRequest } from "./workflow";

export const MAX_FINALIZE_ATTEMPTS = 8;

/**
 * Builds the signed PDF and completion certificate once every signer has signed (status PENDING), stores
 * both encrypted with their hashes, marks the request COMPLETED and emails everyone. Safe to call again:
 * a request that is not PENDING is left alone.
 */
export async function finalizeRequest(requestId: string): Promise<boolean> {
  const claimed = await db().signatureRequest.updateMany({ where: { id: requestId, status: "PENDING" }, data: { finalizeAttempts: { increment: 1 } } });
  if (claimed.count !== 1) return false;
  const req = await loadRequest(requestId);
  try {
    const original = await getFile(req.version.pdfKey, req.documentSha256 ?? req.version.pdfSha256);
    const signatures = await db().signature.findMany({ where: { requestId } });
    const images = new Map(signatures.map((s) => [s.recipientId, new Uint8Array(s.image)]));
    const stamped = await stampFields(
      original,
      req.fields.map((f) => ({ id: f.id, recipientId: f.recipientId, type: f.type, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, value: f.value })),
      images,
    );
    const signedSha256 = sha256Hex(stamped);
    const completedAt = new Date();
    const signer = configuredPdfSigner();
    const level = signer ? signer.level : "electronic";

    await recordEventNow({ ...SYSTEM, requestId, userId: req.userId, type: "DOCUMENT_STAMPED", message: "Signatures applied to the document", metadata: { signedSha256 } });
    const [events, trail] = await Promise.all([db().signatureEvent.findMany({ where: { requestId }, orderBy: { createdAt: "asc" } }), auditTrail(requestId)]);
    const byRecipient = new Map(signatures.map((s) => [s.recipientId, s]));
    const certificate = await buildCertificate({
      requestId,
      title: req.title,
      documentTitle: req.version.document.title,
      documentVersion: req.version.version,
      pageCount: req.version.pageCount,
      sender: { name: req.senderName, email: req.senderEmail, company: req.senderCompany },
      signingOrder: req.signingOrder,
      createdAt: req.createdAt,
      sentAt: req.sentAt,
      completedAt,
      originalSha256: req.documentSha256 ?? req.version.pdfSha256,
      signedSha256,
      signatureLevel: signatureLevelLabel(level),
      consentText: CONSENT_TEXT,
      auditIntact: trail.integrity.ok,
      signers: req.recipients.map((r) => {
        const s = byRecipient.get(r.id);
        return {
          name: r.name,
          email: r.email,
          role: r.role,
          routingOrder: r.routingOrder,
          status: r.status,
          method: s?.method ?? null,
          typedName: s?.typedName ?? null,
          ip: s?.ip ?? null,
          userAgent: s?.userAgent ?? null,
          sentAt: r.sentAt,
          viewedAt: r.viewedAt,
          reviewedAt: r.reviewedAt,
          consentAt: r.consentAt,
          consentIp: r.consentIp,
          emailVerifiedAt: r.emailVerifiedAt,
          smsVerifiedAt: r.smsVerifiedAt,
          signedAt: r.signedAt,
          signatureImage: s ? new Uint8Array(s.image) : null,
        };
      }),
      events: events.map((e) => ({ at: e.createdAt, type: e.type, message: e.message, ip: e.ip })),
    });

    let final = await appendPdf(stamped, certificate);
    if (signer) {
      final = await signer.sign(final, { reason: `Signed: ${req.title}`, name: req.senderCompany || req.senderName, contactInfo: req.senderEmail, location: "Online" });
    }
    const storedFinal = await putFile(req.userId, final);
    const storedCert = await putFile(req.userId, certificate);

    const done = await db().$transaction(async (tx) => {
      const res = await tx.signatureRequest.updateMany({
        where: { id: requestId, status: "PENDING" },
        data: { status: "COMPLETED", completedAt, finalKey: storedFinal.key, finalSha256: storedFinal.sha256, finalSize: storedFinal.size, signatureLevel: level, finalizeError: null },
      });
      if (res.count !== 1) return false;
      await tx.completionCertificate.create({
        data: { requestId, storageKey: storedCert.key, sha256: storedCert.sha256, size: storedCert.size, originalSha256: req.documentSha256 ?? req.version.pdfSha256, finalSha256: storedFinal.sha256 },
      });
      await recordEvent(tx, {
        ...SYSTEM,
        requestId,
        userId: req.userId,
        type: "REQUEST_COMPLETED",
        message: "All parties signed. Final PDF and completion certificate created.",
        metadata: { originalSha256: req.documentSha256, signedSha256, finalSha256: storedFinal.sha256, certificateSha256: storedCert.sha256, signatureLevel: level },
      });
      return true;
    });
    if (!done) return false;
    await sendCompletedEmails(await loadRequest(requestId));
    return true;
  } catch (err) {
    const message = errorMessage(err).slice(0, 1000);
    console.error("[esign] finalize failed", requestId, message);
    await db().signatureRequest.update({ where: { id: requestId }, data: { finalizeError: message } });
    await recordEventNow({ ...SYSTEM, requestId, userId: req.userId, type: "FINALIZE_FAILED", message: `Creating the final document failed: ${message}` }).catch(() => undefined);
    return false;
  }
}

export async function completedFiles(req: WorkflowRequest) {
  const cert = await db().completionCertificate.findUnique({ where: { requestId: req.id } });
  if (!req.finalKey || !req.finalSha256 || !cert) return null;
  const [finalPdf, certificate] = await Promise.all([getFile(req.finalKey, req.finalSha256), getFile(cert.storageKey, cert.sha256)]);
  const base = safeFileName(req.title, "document").replace(/\.(pdf|docx)$/i, "");
  return {
    final: { filename: pdfNameFor(`${base} - signed`), content: finalPdf },
    certificate: { filename: pdfNameFor(`${base} - completion certificate`), content: certificate },
  };
}

/** Emails the signed PDF and certificate to the sender and every recipient (signers, approvers and CC). */
export async function sendCompletedEmails(req: WorkflowRequest, only?: { notificationId: string; to: string; recipientId: string | null }) {
  const files = await completedFiles(req);
  if (!files || !req.completedAt || !req.finalSha256) return;
  const attachments = [
    { filename: files.final.filename, contentType: "application/pdf", content: files.final.content },
    { filename: files.certificate.filename, contentType: "application/pdf", content: files.certificate.content },
  ];
  const ctx = requestContext(req);
  const info = { finalSha256: req.finalSha256, completedAt: req.completedAt, signatureLevel: signatureLevelLabel(req.signatureLevel) };
  const targets = only
    ? [{ to: only.to, name: req.recipients.find((r) => r.id === only.recipientId)?.name ?? req.senderName, recipientId: only.recipientId, notificationId: only.notificationId }]
    : [
        { to: req.senderEmail, name: req.senderName, recipientId: null, notificationId: undefined },
        ...req.recipients.filter((r) => r.email.toLowerCase() !== req.senderEmail.toLowerCase()).map((r) => ({ to: r.email, name: r.name, recipientId: r.id, notificationId: undefined })),
      ];
  for (const t of targets) {
    await deliver({
      userId: req.userId,
      requestId: req.id,
      recipientId: t.recipientId,
      kind: "COMPLETED",
      to: t.to,
      fromName: req.senderName,
      content: completedEmail(ctx, { name: t.name }, info),
      attachments,
      notificationId: t.notificationId,
    });
  }
}
