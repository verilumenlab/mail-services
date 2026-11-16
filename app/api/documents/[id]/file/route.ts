import { authedRoute } from "@/lib/api/handler";
import { recordAuditNow } from "@/lib/esign/audit";
import { getOwnedDocument, readVersionFile } from "@/lib/esign/documents";
import { pdfNameFor } from "@/lib/esign/files";
import { contentDisposition, pdfResponse, requestMeta } from "@/lib/esign/http";

type Params = { id: string };

/**
 * Streams the owner's PDF. ?version=<versionId> picks a version (default: latest), ?original=1 the uploaded
 * file, ?download=1 sends it as an attachment and audits the download.
 */
export const GET = authedRoute<Params>({}, async ({ req, user, params }) => {
  const q = req.nextUrl.searchParams;
  const download = q.get("download") === "1";
  const original = q.get("original") === "1";
  const doc = await getOwnedDocument(user.id, params.id);
  const versionId = q.get("version") || doc.versions[0]?.id || "";
  const { version, bytes } = await readVersionFile(user.id, versionId, original ? "original" : "pdf");
  if (version.documentId !== doc.id) return new Response(null, { status: 404 });
  if (download) {
    await recordAuditNow({
      action: "DOCUMENT_DOWNLOADED",
      actor: `sender:${user.email}`,
      ...requestMeta(req),
      userId: user.id,
      documentId: doc.id,
      details: { version: version.version, file: original ? "original" : "pdf" },
    });
  }
  if (original && version.originalMime !== "application/pdf") {
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": version.originalMime,
        "Content-Disposition": contentDisposition("attachment", version.originalName),
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  return pdfResponse(bytes, original ? version.originalName : pdfNameFor(version.originalName), download ? "attachment" : "inline");
});
