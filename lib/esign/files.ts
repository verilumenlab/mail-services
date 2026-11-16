import { createHash } from "node:crypto";
import { unzipSync } from "fflate";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_PAGES = 200;

export type UploadKind = "pdf" | "docx";

export const PDF_MIME = "application/pdf";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Decides the type from the file content, never from the name or the browser's MIME type. */
export function sniffUpload(bytes: Uint8Array): UploadKind | null {
  if (bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-") return "pdf";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    try {
      let found = false;
      unzipSync(bytes, {
        filter: (file) => {
          if (file.name === "word/document.xml") found = true;
          return false;
        },
      });
      return found ? "docx" : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** File name safe for storage paths and Content-Disposition headers. */
export function safeFileName(name: string, fallback = "document"): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f"<>:|?*]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 150);
  return clean || fallback;
}

export function pdfNameFor(name: string): string {
  return safeFileName(name).replace(/\.(docx|pdf)$/i, "") + ".pdf";
}
