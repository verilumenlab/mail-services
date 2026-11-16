import { authedRoute, ok } from "@/lib/api/handler";
import { RATE_LIMITS } from "@/lib/auth/rateLimit";
import { AppError } from "@/lib/errors";
import { listDocuments, publicVersion, uploadDocument } from "@/lib/esign/documents";
import { MAX_UPLOAD_BYTES } from "@/lib/esign/files";
import { requestMeta } from "@/lib/esign/http";
import { documentTitleSchema } from "@/lib/validation/esign";

export const GET = authedRoute({}, async ({ user }) => {
  const docs = await listDocuments(user.id);
  return ok({
    documents: docs.map((d) => ({
      id: d.id,
      title: d.title,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
      latest: d.versions[0] ? publicVersion(d.versions[0]) : null,
    })),
  });
});

export const POST = authedRoute({ rateLimit: RATE_LIMITS.esignUpload }, async ({ req, user }) => {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("VALIDATION", "Choose a PDF or DOCX file to upload.");
  if (file.size > MAX_UPLOAD_BYTES) throw new AppError("VALIDATION", "The file is larger than 25 MB.");
  const title = documentTitleSchema.parse(String(form.get("title") ?? ""));
  const doc = await uploadDocument(
    user.id,
    title,
    { fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
    { actor: `sender:${user.email}`, ...requestMeta(req) },
  );
  return ok({ document: { id: doc.id, title: doc.title, latest: publicVersion(doc.versions[0]) } }, { status: 201 });
});
