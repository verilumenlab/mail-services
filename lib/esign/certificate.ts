import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { winAnsiSafe } from "./pdf";

export interface CertificateSigner {
  name: string;
  email: string;
  role: string;
  routingOrder: number;
  status: string;
  method: string | null;
  typedName: string | null;
  ip: string | null;
  userAgent: string | null;
  sentAt: Date | null;
  viewedAt: Date | null;
  reviewedAt: Date | null;
  consentAt: Date | null;
  consentIp: string | null;
  emailVerifiedAt: Date | null;
  smsVerifiedAt: Date | null;
  signedAt: Date | null;
  signatureImage: Uint8Array | null;
}

export interface CertificateInput {
  requestId: string;
  title: string;
  documentTitle: string;
  documentVersion: number;
  pageCount: number;
  sender: { name: string; email: string; company: string | null };
  signingOrder: string;
  createdAt: Date;
  sentAt: Date | null;
  completedAt: Date;
  originalSha256: string;
  signedSha256: string;
  signatureLevel: string;
  consentText: string;
  auditIntact: boolean;
  signers: CertificateSigner[];
  events: { at: Date; type: string; message: string; ip: string | null }[];
}

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 48;
const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.39, 0.45, 0.55);
const ACCENT = rgb(0.15, 0.39, 0.92);
const LINE = rgb(0.85, 0.88, 0.92);

function when(d: Date | null): string {
  if (!d) return "-";
  return `${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

class Writer {
  page!: PDFPage;
  y = 0;
  pageNo = 0;
  constructor(private doc: PDFDocument, private font: PDFFont, private bold: PDFFont, private footer: string) {
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([A4.w, A4.h]);
    this.pageNo += 1;
    this.y = A4.h - MARGIN;
    this.page.drawText(winAnsiSafe(this.footer), { x: MARGIN, y: 24, size: 7, font: this.font, color: MUTED });
    this.page.drawText(`Page ${this.pageNo}`, { x: A4.w - MARGIN - 30, y: 24, size: 7, font: this.font, color: MUTED });
  }

  ensure(height: number) {
    if (this.y - height < MARGIN + 10) this.newPage();
  }

  wrap(text: string, size: number, font: PDFFont, width: number): string[] {
    const words = winAnsiSafe(text).split(/\s+/);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) line = next;
      else {
        if (line) lines.push(line);
        let w = word;
        while (font.widthOfTextAtSize(w, size) > width && w.length > 1) {
          let cut = w.length;
          while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut -= 1;
          lines.push(w.slice(0, cut));
          w = w.slice(cut);
        }
        line = w;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }

  text(text: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number; gap?: number } = {}) {
    const size = opts.size ?? 9;
    const font = opts.bold ? this.bold : this.font;
    const x = MARGIN + (opts.indent ?? 0);
    for (const line of this.wrap(text, size, font, A4.w - MARGIN - x)) {
      this.ensure(size + 4);
      this.y -= size + 3;
      this.page.drawText(line, { x, y: this.y, size, font, color: opts.color ?? INK });
    }
    this.y -= opts.gap ?? 2;
  }

  row(label: string, value: string, indent = 0) {
    const size = 8.5;
    const labelW = 150;
    const x = MARGIN + indent;
    const lines = this.wrap(value, size, this.font, A4.w - MARGIN - x - labelW);
    this.ensure((size + 3) * lines.length + 2);
    this.y -= size + 3;
    this.page.drawText(winAnsiSafe(label), { x, y: this.y, size, font: this.font, color: MUTED });
    lines.forEach((line, i) => {
      if (i) this.y -= size + 3;
      this.page.drawText(line, { x: x + labelW, y: this.y, size, font: this.font, color: INK });
    });
    this.y -= 2;
  }

  heading(text: string) {
    this.ensure(40);
    this.y -= 14;
    this.page.drawText(winAnsiSafe(text), { x: MARGIN, y: this.y - 12, size: 12, font: this.bold, color: INK });
    this.y -= 18;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: A4.w - MARGIN, y: this.y }, thickness: 0.6, color: LINE });
    this.y -= 4;
  }
}

/** A standalone completion certificate: request details, document hashes, every signer and the full event timeline. */
export async function buildCertificate(input: CertificateInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Completion certificate - ${winAnsiSafe(input.title)}`);
  doc.setProducer("Sorts E-Signature");
  doc.setCreationDate(input.completedAt);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, font, bold, `Completion certificate - request ${input.requestId}`);

  w.page.drawRectangle({ x: 0, y: A4.h - 6, width: A4.w, height: 6, color: ACCENT });
  w.text("Certificate of Completion", { size: 20, bold: true, gap: 4 });
  w.text(input.signatureLevel, { size: 10, color: ACCENT, gap: 10 });

  w.heading("Request");
  w.row("Title", input.title);
  w.row("Document", `${input.documentTitle} (version ${input.documentVersion}, ${input.pageCount} page${input.pageCount === 1 ? "" : "s"})`);
  w.row("Request ID", input.requestId);
  w.row("Sender", `${input.sender.name} <${input.sender.email}>${input.sender.company ? `, ${input.sender.company}` : ""}`);
  w.row("Signing order", input.signingOrder === "SEQUENTIAL" ? "Sequential (in routing order)" : "Parallel");
  w.row("Created", when(input.createdAt));
  w.row("Sent", when(input.sentAt));
  w.row("Completed", when(input.completedAt));

  w.heading("Document integrity");
  w.row("Original PDF SHA-256", input.originalSha256);
  w.row("Signed PDF SHA-256", input.signedSha256);
  w.text(
    "The signed PDF hash covers the original pages with the signatures applied, before this certificate was attached. The hash of the final file (signed pages plus this certificate) is recorded in the audit log and in the completion email.",
    { size: 7.5, color: MUTED, gap: 4 },
  );
  w.row("Audit trail", input.auditIntact ? "Hash chain verified intact at completion" : "WARNING: the audit hash chain did not verify");

  w.heading("Signers");
  for (const s of input.signers) {
    w.ensure(150);
    w.text(`${s.routingOrder}. ${s.name} <${s.email}>`, { size: 10, bold: true, gap: 1 });
    w.row("Role", s.role === "APPROVER" ? "Approver" : s.role === "CC" ? "Receives a copy" : "Signer", 10);
    if (s.role !== "CC") {
      w.row("Status", s.status, 10);
      w.row("Signature method", s.method ? `${s.method.toLowerCase()}${s.typedName ? ` ("${s.typedName}")` : ""}` : "-", 10);
      w.row("Email sent", when(s.sentAt), 10);
      w.row("Viewed", when(s.viewedAt), 10);
      w.row("Reviewed all pages", when(s.reviewedAt), 10);
      w.row("Consent to e-sign", `${when(s.consentAt)}${s.consentIp ? ` from ${s.consentIp}` : ""}`, 10);
      w.row("Email code verified", when(s.emailVerifiedAt), 10);
      if (s.smsVerifiedAt) w.row("SMS code verified", when(s.smsVerifiedAt), 10);
      w.row("Signed", when(s.signedAt), 10);
      w.row("IP address", s.ip ?? "-", 10);
      w.row("Browser", s.userAgent ?? "-", 10);
      if (s.signatureImage) {
        try {
          const img = await doc.embedPng(s.signatureImage);
          const scale = Math.min(160 / img.width, 50 / img.height);
          w.ensure(60);
          w.y -= img.height * scale + 6;
          w.page.drawRectangle({ x: MARGIN + 160, y: w.y - 2, width: img.width * scale + 8, height: img.height * scale + 8, borderColor: LINE, borderWidth: 0.6 });
          w.page.drawImage(img, { x: MARGIN + 164, y: w.y + 2, width: img.width * scale, height: img.height * scale });
          w.y -= 6;
        } catch {
          w.row("Signature image", "could not be rendered", 10);
        }
      }
    }
    w.y -= 6;
  }

  w.heading("Electronic signature disclosure");
  w.text(input.consentText, { size: 8, color: MUTED, gap: 4 });

  w.heading("Event timeline");
  for (const e of input.events) {
    w.text(`${when(e.at)}  ${e.message}${e.ip ? `  [${e.ip}]` : ""}`, { size: 7.5, gap: 1 });
  }

  return doc.save({ useObjectStreams: false });
}
