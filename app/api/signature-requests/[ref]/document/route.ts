import { publicRoute } from "@/lib/api/handler";
import { RATE_LIMITS } from "@/lib/auth/rateLimit";
import { AppError } from "@/lib/errors";
import { recordEventNow } from "@/lib/esign/audit";
import { completedFiles } from "@/lib/esign/finalize";
import { pdfNameFor } from "@/lib/esign/files";
import { pdfResponse, requestMeta } from "@/lib/esign/http";
import { resolveLink } from "@/lib/esign/signer";
import { getFile } from "@/lib/esign/storage";

type Params = { ref: string };

/**
 * Streams the PDF to a recipient, authorised by the link token. Without ?file it is the document to sign
 * (only while the link is usable); ?file=final|certificate returns the completed files to any party.
 */
export const GET = publicRoute<Params>({ rateLimit: RATE_LIMITS.signerView }, async ({ req, params }) => {
  const file = req.nextUrl.searchParams.get("file");
  const { problem, ctx } = await resolveLink(params.ref);
  if (!ctx || problem === "INVALID") throw new AppError("NOT_FOUND", "This signing link is not valid.");
  const meta = requestMeta(req);
  const base = { actor: `signer:${ctx.me.email}`, ...meta, requestId: ctx.req.id, userId: ctx.req.userId, recipientId: ctx.me.id };

  if (file === "final" || file === "certificate") {
    if (ctx.req.status !== "COMPLETED") throw new AppError("INVALID_STATE", "The signed document is not ready yet.");
    if (ctx.me.tokenRevokedAt) throw new AppError("FORBIDDEN", "This link was withdrawn.");
    const files = await completedFiles(ctx.req);
    if (!files) throw new AppError("NOT_FOUND", "The signed document is not available.");
    const chosen = file === "final" ? files.final : files.certificate;
    await recordEventNow({ ...base, type: "DOCUMENT_DOWNLOADED", message: `${ctx.me.name} downloaded the ${file === "final" ? "signed PDF" : "completion certificate"}`, metadata: { file } });
    return pdfResponse(chosen.content, chosen.filename, "attachment");
  }

  const readable = problem === null || problem === "SIGNED" || problem === "NOT_YOUR_TURN" || problem === "FINALIZING";
  if (!readable || !ctx.req.documentSha256) throw new AppError("FORBIDDEN", "This document is no longer available from this link.");
  const bytes = await getFile(ctx.req.version.pdfKey, ctx.req.documentSha256);
  return pdfResponse(bytes, pdfNameFor(ctx.req.version.originalName), "inline");
});
