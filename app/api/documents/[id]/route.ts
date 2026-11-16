import { authedRoute, ok, readJson } from "@/lib/api/handler";
import { db } from "@/lib/database/prisma";
import { appendAudit } from "@/lib/esign/audit";
import { getOwnedDocument, publicVersion } from "@/lib/esign/documents";
import { requestMeta } from "@/lib/esign/http";
import { renameDocumentSchema } from "@/lib/validation/esign";

type Params = { id: string };

export const GET = authedRoute<Params>({}, async ({ user, params }) => {
  const doc = await getOwnedDocument(user.id, params.id);
  const requests = await db().signatureRequest.findMany({
    where: { userId: user.id, version: { documentId: doc.id } },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, status: true, createdAt: true, sentAt: true, completedAt: true, version: { select: { version: true } } },
  });
  return ok({
    document: {
      id: doc.id,
      title: doc.title,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
      versions: doc.versions.map(publicVersion),
    },
    requests: requests.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      version: r.version.version,
      createdAt: r.createdAt.toISOString(),
      sentAt: r.sentAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
    })),
  });
});

export const PATCH = authedRoute<Params>({}, async ({ req, user, params }) => {
  const input = await readJson(req, renameDocumentSchema);
  const doc = await getOwnedDocument(user.id, params.id);
  await db().$transaction(async (tx) => {
    await tx.document.update({ where: { id: doc.id }, data: { title: input.title } });
    await appendAudit(tx, {
      action: "DOCUMENT_RENAMED",
      actor: `sender:${user.email}`,
      ...requestMeta(req),
      userId: user.id,
      documentId: doc.id,
      details: { from: doc.title, to: input.title },
    });
  });
  return ok({ ok: true });
});
