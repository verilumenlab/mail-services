import { authedRoute, ok, readJson } from "@/lib/api/handler";
import { db } from "@/lib/database/prisma";
import { requestMeta } from "@/lib/esign/http";
import { createDraft } from "@/lib/esign/requests";
import { requestDraftSchema } from "@/lib/validation/esign";
import { z } from "zod";

const statusFilter = z
  .enum(["DRAFT", "SENT", "DELIVERED", "VIEWED", "IN_REVIEW", "PARTIALLY_SIGNED", "PENDING", "COMPLETED", "REJECTED", "EXPIRED", "CANCELLED"])
  .optional();

export const GET = authedRoute({}, async ({ user, req }) => {
  const status = statusFilter.safeParse(req.nextUrl.searchParams.get("status") ?? undefined);
  const rows = await db().signatureRequest.findMany({
    where: { userId: user.id, ...(status.success && status.data ? { status: status.data } : {}) },
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: {
      id: true,
      title: true,
      status: true,
      expiresAt: true,
      sentAt: true,
      completedAt: true,
      updatedAt: true,
      recipients: { select: { name: true, email: true, role: true, status: true } },
      version: { select: { version: true, document: { select: { id: true, title: true } } } },
    },
  });
  return ok({
    requests: rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      expiresAt: r.expiresAt.toISOString(),
      sentAt: r.sentAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      updatedAt: r.updatedAt.toISOString(),
      document: { id: r.version.document.id, title: r.version.document.title, version: r.version.version },
      recipients: r.recipients,
    })),
  });
});

export const POST = authedRoute({}, async ({ req, user }) => {
  const input = await readJson(req, requestDraftSchema);
  const created = await createDraft(user.id, input, { actor: `sender:${user.email}`, ...requestMeta(req) });
  return ok({ request: { id: created.id } }, { status: 201 });
});
