import { degrees, PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { AppError } from "@/lib/errors";
import { MAX_PAGES } from "./files";
import { fitContain, placementFor, type NormalizedRect, type PageBox, type Placement } from "./geometry";

export function pageBoxes(doc: PDFDocument): PageBox[] {
  return doc.getPages().map((page) => {
    const crop = page.getCropBox();
    return { x: crop.x, y: crop.y, width: crop.width, height: crop.height, rotation: page.getRotation().angle };
  });
}

/** Opens an uploaded PDF and rejects files that cannot be signed (encrypted, empty, too long, corrupt). */
export async function inspectPdf(bytes: Uint8Array): Promise<{ pageCount: number; pages: PageBox[] }> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    const name = err instanceof Error ? err.constructor.name : "";
    if (name === "EncryptedPDFError" || (err instanceof Error && /encrypt/i.test(err.message))) {
      throw new AppError("VALIDATION", "This PDF is password protected or encrypted. Remove the protection and upload it again.");
    }
    throw new AppError("VALIDATION", "This file is not a readable PDF.");
  }
  const pageCount = doc.getPageCount();
  if (pageCount === 0) throw new AppError("VALIDATION", "This PDF has no pages.");
  if (pageCount > MAX_PAGES) throw new AppError("VALIDATION", `This PDF has ${pageCount} pages. The limit is ${MAX_PAGES}.`);
  return { pageCount, pages: pageBoxes(doc) };
}

/** The standard PDF fonts only cover Windows-1252; anything else is replaced so stamping never fails. */
export function winAnsiSafe(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\x20-\x7E\u00A0-\u00FF\u20AC]/g, "?");
}

export interface StampField extends NormalizedRect {
  id: string;
  recipientId: string;
  type: "SIGNATURE" | "INITIALS" | "DATE" | "NAME" | "TEXT";
  page: number;
  value: string | null;
}

/** Point inside a placed (possibly rotated) box, measured from its bottom-left along its own axes. */
function at(p: Placement, ox: number, oy: number): { x: number; y: number } {
  const r = (p.rotate * Math.PI) / 180;
  return { x: p.x + ox * Math.cos(r) - oy * Math.sin(r), y: p.y + ox * Math.sin(r) + oy * Math.cos(r) };
}

function drawImageIn(page: PDFPage, p: Placement, img: PDFImage) {
  const fit = fitContain(p.width, p.height, img.width, img.height);
  const o = at(p, fit.offsetX, fit.offsetY);
  page.drawImage(img, { x: o.x, y: o.y, width: fit.width, height: fit.height, rotate: degrees(p.rotate) });
}

function drawTextIn(page: PDFPage, p: Placement, text: string, font: PDFFont) {
  const clean = winAnsiSafe(text);
  let size = Math.max(5, Math.min(14, p.height * 0.7));
  while (size > 5 && font.widthOfTextAtSize(clean, size) > p.width - 2) size -= 0.5;
  let shown = clean;
  while (shown.length > 1 && font.widthOfTextAtSize(shown, size) > p.width - 2) shown = shown.slice(0, -1);
  const baseline = (p.height - font.heightAtSize(size)) / 2 + font.heightAtSize(size) * 0.22;
  const o = at(p, 1, Math.max(0, baseline));
  page.drawText(shown, { x: o.x, y: o.y, size, font, color: rgb(0.05, 0.09, 0.2), rotate: degrees(p.rotate) });
}

/**
 * Draws signatures and filled values onto a copy of the original PDF at the positions the sender placed.
 * Pages, text and layout of the original are left untouched; only new content is added on top.
 */
export async function stampFields(original: Uint8Array, fields: StampField[], signatureImages: Map<string, Uint8Array>): Promise<Uint8Array> {
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boxes = pageBoxes(doc);
  const embedded = new Map<string, PDFImage>();
  async function image(key: string, bytes: Uint8Array) {
    let img = embedded.get(key);
    if (!img) {
      img = await doc.embedPng(bytes);
      embedded.set(key, img);
    }
    return img;
  }
  for (const f of fields) {
    const page = doc.getPage(f.page - 1);
    const p = placementFor(boxes[f.page - 1], f);
    if (f.type === "SIGNATURE") {
      const bytes = signatureImages.get(f.recipientId);
      if (bytes) drawImageIn(page, p, await image(`sig:${f.recipientId}`, bytes));
    } else if (f.type === "INITIALS") {
      const data = f.value?.startsWith("data:image/png;base64,") ? Buffer.from(f.value.slice(22), "base64") : signatureImages.get(f.recipientId);
      if (data) drawImageIn(page, p, await image(f.value ? `ini:${f.id}` : `sig:${f.recipientId}`, data));
    } else if (f.value) {
      drawTextIn(page, p, f.value, font);
    }
  }
  return doc.save({ useObjectStreams: false });
}

/** Original pages followed by every page of `extra` (the completion certificate). */
export async function appendPdf(base: Uint8Array, extra: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(base, { updateMetadata: false });
  const add = await PDFDocument.load(extra);
  const pages = await doc.copyPages(add, add.getPageIndices());
  pages.forEach((p) => doc.addPage(p));
  return doc.save({ useObjectStreams: false });
}
