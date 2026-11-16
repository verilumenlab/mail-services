import "server-only";
import { PDFDocument } from "pdf-lib";
import { AppError } from "@/lib/errors";

const MAX_IMAGE_BYTES = 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type SharpFactory = (typeof import("sharp"))["default"];

async function loadSharp(): Promise<SharpFactory | null> {
  try {
    const mod = await import("sharp");
    return mod.default;
  } catch {
    return null;
  }
}

/**
 * Decodes a signature PNG from the browser and re-encodes it, dropping metadata and anything that is not
 * pixels. Rejects files that are not PNG, too large, too small or blank.
 */
export async function normalizeSignatureImage(dataUrl: string, what = "signature"): Promise<{ png: Buffer; width: number; height: number }> {
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  const bytes = Buffer.from(b64, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new AppError("VALIDATION", `The ${what} image must be a PNG under 1 MB.`);
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new AppError("VALIDATION", `The ${what} image is not a valid PNG.`);

  const sharp = await loadSharp();
  if (sharp) {
    try {
      const pipeline = sharp(bytes, { limitInputPixels: 8_000_000 }).resize({ width: 1600, height: 800, fit: "inside", withoutEnlargement: true });
      const { data, info } = await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
      const stats = await sharp(data).stats();
      const alpha = stats.channels[stats.channels.length - 1];
      const blank = stats.isOpaque ? stats.channels.slice(0, 3).every((c) => c.max - c.min < 8) : alpha.max < 16;
      if (blank) throw new AppError("VALIDATION", `The ${what} is empty. Draw, upload or type it again.`);
      if (info.width < 10 || info.height < 10) throw new AppError("VALIDATION", `The ${what} image is too small.`);
      return { png: data, width: info.width, height: info.height };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError("VALIDATION", `The ${what} image could not be read.`);
    }
  }

  try {
    const probe = await PDFDocument.create();
    const img = await probe.embedPng(bytes);
    if (img.width < 10 || img.height < 10 || img.width > 4000 || img.height > 4000) throw new AppError("VALIDATION", `The ${what} image has an unusable size.`);
    return { png: bytes, width: img.width, height: img.height };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("VALIDATION", `The ${what} image could not be read.`);
  }
}
