import "server-only";
import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";

/**
 * Applies a certificate-based (PAdES-style, CMS detached) digital signature to the final PDF. Off unless
 * configured; without it the output is an electronic signature backed by the audit trail and hashes.
 */
export interface PdfSigner {
  /** Shown on the certificate and request, e.g. "pkcs12:Acme Ltd". */
  readonly level: string;
  sign(pdf: Uint8Array, info: { reason: string; name: string; contactInfo: string; location: string }): Promise<Uint8Array>;
}

class P12PdfSigner implements PdfSigner {
  constructor(
    private p12Path: string,
    private passphrase: string,
    readonly level: string,
  ) {}

  async sign(pdf: Uint8Array, info: { reason: string; name: string; contactInfo: string; location: string }): Promise<Uint8Array> {
    const [{ pdflibAddPlaceholder }, { P12Signer }, signpdfMod, { SUBFILTER_ETSI_CADES_DETACHED }] = await Promise.all([
      import("@signpdf/placeholder-pdf-lib"),
      import("@signpdf/signer-p12"),
      import("@signpdf/signpdf"),
      import("@signpdf/utils"),
    ]);
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    pdflibAddPlaceholder({ pdfDoc: doc, ...info, subFilter: SUBFILTER_ETSI_CADES_DETACHED, signatureLength: 16_384, appName: "Sorts E-Signature" });
    const prepared = await doc.save({ useObjectStreams: false });
    const signer = new P12Signer(await readFile(this.p12Path), { passphrase: this.passphrase });
    const signpdf = signpdfMod.default;
    return new Uint8Array(await signpdf.sign(Buffer.from(prepared), signer));
  }
}

/** ESIGN_PDF_SIGNER=p12 with ESIGN_P12_PATH (and ESIGN_P12_PASSPHRASE) enables certificate-based signing. */
export function configuredPdfSigner(): PdfSigner | null {
  if (process.env.ESIGN_PDF_SIGNER?.trim().toLowerCase() !== "p12") return null;
  const path = process.env.ESIGN_P12_PATH?.trim();
  if (!path) return null;
  return new P12PdfSigner(path, process.env.ESIGN_P12_PASSPHRASE ?? "", `pkcs12:${process.env.ESIGN_P12_LABEL?.trim() || "organisation certificate"}`);
}
