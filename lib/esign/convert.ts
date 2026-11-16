import "server-only";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AppError } from "@/lib/errors";

const CONVERT_TIMEOUT_MS = 120_000;

const CANDIDATES = [
  "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
  "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
  "/usr/bin/soffice",
  "/usr/bin/libreoffice",
  "/usr/lib/libreoffice/program/soffice",
  "/opt/libreoffice/program/soffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
];

export function findLibreOffice(): string | null {
  const configured = process.env.LIBREOFFICE_PATH?.trim();
  if (configured) return existsSync(configured) ? configured : null;
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.slice(-2000) });
    });
  });
}

/**
 * Converts a DOCX to PDF with LibreOffice in headless mode. Each conversion uses its own temporary
 * profile, so parallel conversions do not share state and no macros or user settings apply.
 */
export async function convertDocxToPdf(docx: Uint8Array): Promise<Buffer> {
  const soffice = findLibreOffice();
  if (!soffice) {
    throw new AppError(
      "NOT_CONFIGURED",
      "DOCX conversion needs LibreOffice on the server. Install LibreOffice (or set LIBREOFFICE_PATH), or upload a PDF instead.",
    );
  }
  const work = await mkdtemp(path.join(os.tmpdir(), "esign-convert-"));
  try {
    const input = path.join(work, "document.docx");
    await writeFile(input, docx);
    const profile = pathToFileURL(path.join(work, "profile")).toString();
    const { code, output } = await run(
      soffice,
      [`-env:UserInstallation=${profile}`, "--headless", "--norestore", "--nolockcheck", "--convert-to", "pdf:writer_pdf_Export", "--outdir", work, input],
      CONVERT_TIMEOUT_MS,
    );
    const out = path.join(work, "document.pdf");
    if (code !== 0 || !existsSync(out)) {
      console.error("[esign] DOCX conversion failed", code, output);
      throw new AppError("VALIDATION", "This DOCX could not be converted to PDF. Open it in Word, save it again, or upload a PDF.");
    }
    return await readFile(out);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
