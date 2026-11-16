import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { sha256Hex } from "./files";

const MAGIC = Buffer.from("ESG1");

function storageRoot(): string {
  return path.resolve(process.env.ESIGN_STORAGE_DIR?.trim() || path.join(process.cwd(), "data", "esign"));
}

/** A key for one e-sign purpose, derived from TOKEN_ENCRYPTION_KEY and separate from the key that protects OAuth tokens. */
export function derivedSecret(purpose: string): Buffer {
  const raw = Buffer.from(env().TOKEN_ENCRYPTION_KEY || "", "base64");
  if (raw.length !== 32) throw new AppError("NOT_CONFIGURED", "TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return Buffer.from(hkdfSync("sha256", raw, Buffer.from("sorts-esign"), Buffer.from(purpose), 32));
}

function fileKey(): Buffer {
  return derivedSecret("document-files-v1");
}

export function encryptBytes(plain: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", fileKey(), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
}

export function decryptBytes(payload: Buffer): Buffer {
  if (payload.length < 32 || !payload.subarray(0, 4).equals(MAGIC)) throw new AppError("INTERNAL", "Stored file is not readable.");
  const iv = payload.subarray(4, 16);
  const tag = payload.subarray(16, 32);
  const decipher = createDecipheriv("aes-256-gcm", fileKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload.subarray(32)), decipher.final()]);
}

function resolveKey(key: string): string {
  if (!/^[a-z0-9]+\/[a-z0-9-]+\.bin$/i.test(key)) throw new AppError("INTERNAL", "Invalid storage key.");
  return path.join(storageRoot(), key);
}

/** Stores a file encrypted at rest. Returns an opaque key; files are never served by path. */
export async function putFile(ownerId: string, bytes: Uint8Array): Promise<{ key: string; sha256: string; size: number }> {
  const owner = ownerId.replace(/[^a-z0-9]/gi, "").slice(0, 40) || "shared";
  const key = `${owner}/${randomBytes(16).toString("hex")}-${Date.now().toString(36)}.bin`;
  const dest = resolveKey(key);
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  await writeFile(tmp, encryptBytes(bytes), { mode: 0o600 });
  await rename(tmp, dest);
  return { key, sha256: sha256Hex(bytes), size: bytes.byteLength };
}

/** Reads and decrypts a stored file. With expectedSha256, refuses a file whose content changed. */
export async function getFile(key: string, expectedSha256?: string | null): Promise<Buffer> {
  let payload: Buffer;
  try {
    payload = await readFile(resolveKey(key));
  } catch {
    throw new AppError("NOT_FOUND", "The stored document file is missing.");
  }
  let plain: Buffer;
  try {
    plain = decryptBytes(payload);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("CONFLICT", "The stored document failed its integrity check and was not served.");
  }
  if (expectedSha256 && sha256Hex(plain) !== expectedSha256) {
    throw new AppError("CONFLICT", "The stored document does not match its recorded SHA-256 hash and was not served.");
  }
  return plain;
}
