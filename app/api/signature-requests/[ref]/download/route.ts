import { authedRoute } from "@/lib/api/handler";
import { AppError } from "@/lib/errors";
import { recordEventNow } from "@/lib/esign/audit";
import { completedFiles } from "@/lib/esign/finalize";
import { pdfNameFor } from "@/lib/esign/files";
import { pdfResponse, requestMeta } from "@/lib/esign/http";
import { getOwnedRequest } from "@/lib/esign/requests";
import { getFile } from "@/lib/esign/storage";
import { loadRequest } from "@/lib/esign/workflow";

type Params = { ref: string };

/** ?file=final|certificate|original. Every file is checked against its stored SHA-256 before it is served. */
export const GET = authedRoute<Params>({}, async ({ req, user, params }) => {
  const file = req.nextUrl.searchParams.get("file") ?? "final";
  if (!["final", "certificate", "original"].includes(file)) throw new AppError("VALIDATION", "file must be final, certificate or original.");
  const owned = await getOwnedRequest(user.id, params.ref);
  let bytes: Uint8Array;
  let name: string;
  if (file === "original") {
    bytes = await getFile(owned.version.pdfKey, owned.documentSha256 ?? owned.version.pdfSha256);
    name = pdfNameFor(owned.version.originalName);
  } else {
    if (owned.status !== "COMPLETED") throw new AppError("INVALID_STATE", "The signed document is not ready yet.");
    const files = await completedFiles(await loadRequest(owned.id));
    if (!files) throw new AppError("NOT_FOUND", "The signed files are missing.");
    const chosen = file === "final" ? files.final : files.certificate;
    bytes = chosen.content;
    name = chosen.filename;
  }
  await recordEventNow({
    actor: `sender:${user.email}`,
    ...requestMeta(req),
    requestId: owned.id,
    userId: user.id,
    type: "DOCUMENT_DOWNLOADED",
    message: `Sender downloaded the ${file === "final" ? "signed PDF" : file === "certificate" ? "completion certificate" : "original PDF"}`,
    metadata: { file },
  });
  return pdfResponse(bytes, name, req.nextUrl.searchParams.get("inline") === "1" ? "inline" : "attachment");
});
