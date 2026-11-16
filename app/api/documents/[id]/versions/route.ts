import { authedRoute, ok } from "@/lib/api/handler";
import { RATE_LIMITS } from "@/lib/auth/rateLimit";
import { AppError } from "@/lib/errors";
import { addDocumentVersion, publicVersion } from "@/lib/esign/documents";
import { MAX_UPLOAD_BYTES } from "@/lib/esign/files";
import { requestMeta } from "@/lib/esign/http";

type Params = { id: string };

export const POST = authedRoute<Params>({ rateLimit: RATE_LIMITS.esignUpload }, async ({ req, user, params }) => {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("VALIDATION", "Choose a PDF or DOCX file to upload.");
  if (file.size > MAX_UPLOAD_BYTES) throw new AppError("VALIDATION", "The file is larger than 25 MB.");
  const version = await addDocumentVersion(
    user.id,
    params.id,
    { fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
    { actor: `sender:${user.email}`, ...requestMeta(req) },
  );
  return ok({ version: publicVersion(version) }, { status: 201 });
});
