import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes as base64url (43 characters). Only its SHA-256 is stored for lookups. */
export function newLinkToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isLinkTokenShape(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function signingLink(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, "")}/sign/${token}`;
}

export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export type LinkState = "OK" | "REVOKED" | "EXPIRED";

/** Whether a recipient's link may still be used, given the request expiry and revocation. */
export function linkState(input: { revokedAt: Date | null; expiresAt: Date; now: Date }): LinkState {
  if (input.revokedAt) return "REVOKED";
  if (input.now.getTime() >= input.expiresAt.getTime()) return "EXPIRED";
  return "OK";
}
