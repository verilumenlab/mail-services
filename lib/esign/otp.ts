import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_SENDS = 3;
export const OTP_SEND_WINDOW_MS = 15 * 60 * 1000;
export const SIGNING_SESSION_MS = 30 * 60 * 1000;

export function generateOtp(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
}

/** Bound to the recipient and channel so a code for one signer or channel never verifies another. */
export function hashOtp(secret: string | Buffer, recipientId: string, channel: string, code: string): string {
  return createHmac("sha256", secret).update(`${recipientId}:${channel}:${code}`).digest("hex");
}

export function otpMatches(secret: string | Buffer, recipientId: string, channel: string, code: string, storedHash: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const a = Buffer.from(hashOtp(secret, recipientId, channel, code), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type OtpCheck = "OK" | "EXPIRED" | "LOCKED" | "WRONG";

/** Outcome of one verification try against the latest code (attempts counts this try). */
export function checkOtpAttempt(input: { matches: boolean; attempts: number; expiresAt: Date; now: Date }): OtpCheck {
  if (input.now.getTime() > input.expiresAt.getTime()) return "EXPIRED";
  if (input.attempts > OTP_MAX_ATTEMPTS) return "LOCKED";
  return input.matches ? "OK" : input.attempts >= OTP_MAX_ATTEMPTS ? "LOCKED" : "WRONG";
}

export function canSendOtp(recentSends: Date[], now: Date): boolean {
  return recentSends.filter((d) => now.getTime() - d.getTime() < OTP_SEND_WINDOW_MS).length < OTP_MAX_SENDS;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const shown = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${shown}${"*".repeat(Math.max(1, local.length - shown.length))}@${domain}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length <= 4 ? "****" : `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}
