import "server-only";
import { db } from "@/lib/database/prisma";
import { AppError } from "@/lib/errors";
import { appendAudit, type Actor } from "./audit";
import { convertDocxToPdf } from "./convert";
import { DOCX_MIME, MAX_UPLOAD_BYTES, PDF_MIME, safeFileName, sniffUpload } from "./files";
import { inspectPdf } from "./pdf";
import { getFile, putFile } from "./storage";

export interface UploadInput {
  fileName: string;
  bytes: Uint8Array;
}

async function prepareVersion(userId: string, input: UploadInput) {
  if (input.bytes.byteLength === 0) throw new AppError("VALIDATION", "The file is empty.");
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new AppError("VALIDATION", "The file is larger than 25 MB.");
  const kind = sniffUpload(input.bytes);
  if (!kind) throw new AppError("VALIDATION", "Only PDF and Word (.docx) files can be uploaded.");
  const pdf = kind === "pdf" ? Buffer.from(input.bytes) : await convertDocxToPdf(input.bytes);
  const info = await inspectPdf(pdf);
  const original = await putFile(userId, input.bytes);
  const converted = kind === "pdf" ? original : await putFile(userId, pdf);
  return {
    originalName: safeFileName(input.fileName, kind === "pdf" ? "document.pdf" : "document.docx"),
    originalMime: kind === "pdf" ? PDF_MIME : DOCX_MIME,
    originalSize: original.size,
    originalSha256: original.sha256,
    originalKey: original.key,
    pdfSize: converted.size,
    pdfSha256: converted.sha256,
    pdfKey: converted.key,
    pageCount: info.pageCount,
    converted: kind === "docx",
  };
}

export async function uploadDocument(userId: string, title: string, input: UploadInput, actor: Actor) {
  const version = await prepareVersion(userId, input);
  return db().$transaction(async (tx) => {
    const doc = await tx.document.create({
      data: { userId, title: title.trim() || version.originalName.replace(/\.(pdf|docx)$/i, ""), versions: { create: { version: 1, ...version } } },
      include: { versions: true },
    });
    await appendAudit(tx, {
      ...actor,
      action: "DOCUMENT_UPLOADED",
      userId,
      documentId: doc.id,
      details: { title: doc.title, version: 1, fileName: version.originalName, sha256: version.originalSha256, pdfSha256: version.pdfSha256, converted: version.converted, pages: version.pageCount },
    });
    return doc;
  });
}

export async function addDocumentVersion(userId: string, documentId: string, input: UploadInput, actor: Actor) {
  await getOwnedDocument(userId, documentId);
  const version = await prepareVersion(userId, input);
  return db().$transaction(async (tx) => {
    const last = await tx.documentVersion.findFirst({ where: { documentId }, orderBy: { version: "desc" }, select: { version: true } });
    const created = await tx.documentVersion.create({ data: { documentId, version: (last?.version ?? 0) + 1, ...version } });
    await tx.document.update({ where: { id: documentId }, data: { updatedAt: new Date() } });
    await appendAudit(tx, {
      ...actor,
      action: "DOCUMENT_VERSION_UPLOADED",
      userId,
      documentId,
      details: { version: created.version, fileName: version.originalName, sha256: version.originalSha256, pdfSha256: version.pdfSha256, converted: version.converted },
    });
    return created;
  });
}

export async function getOwnedDocument(userId: string, documentId: string) {
  const doc = await db().document.findFirst({ where: { id: documentId, userId }, include: { versions: { orderBy: { version: "desc" } } } });
  if (!doc) throw new AppError("NOT_FOUND", "Document not found.");
  return doc;
}

export async function listDocuments(userId: string) {
  return db().document.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 200,
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
}

export function publicVersion(v: { id: string; version: number; originalName: string; originalMime: string; originalSize: number; originalSha256: string; pdfSize: number; pdfSha256: string; pageCount: number; converted: boolean; createdAt: Date }) {
  return {
    id: v.id,
    version: v.version,
    originalName: v.originalName,
    originalMime: v.originalMime,
    originalSize: v.originalSize,
    originalSha256: v.originalSha256,
    pdfSize: v.pdfSize,
    pdfSha256: v.pdfSha256,
    pageCount: v.pageCount,
    converted: v.converted,
    createdAt: v.createdAt.toISOString(),
  };
}

/** The owner's PDF (or original upload) for one version, checked against its stored hash. */
export async function readVersionFile(userId: string, versionId: string, which: "pdf" | "original") {
  const v = await db().documentVersion.findFirst({ where: { id: versionId, document: { userId } } });
  if (!v) throw new AppError("NOT_FOUND", "Document version not found.");
  const bytes = which === "pdf" ? await getFile(v.pdfKey, v.pdfSha256) : await getFile(v.originalKey, v.originalSha256);
  return { version: v, bytes };
}
