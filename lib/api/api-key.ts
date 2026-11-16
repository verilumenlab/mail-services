import "server-only";
import type { NextRequest } from "next/server";
import { randomToken, sha256 } from "@/lib/crypto/tokens";
import { db } from "@/lib/database/prisma";
import { AppError } from "@/lib/errors";
import { isMainPerson, type SessionUser } from "@/lib/auth/session";

const KEY_PREFIX = "srots_";

export function hashApiKey(raw: string): string {
  return sha256(raw);
}

export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = `${KEY_PREFIX}${randomToken(32)}`;
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 12) };
}

export async function resolveApiKeyUser(req: NextRequest): Promise<SessionUser> {
  const header = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const raw = match?.[1]?.trim() ?? "";
  if (!raw.startsWith(KEY_PREFIX) || raw.length < 20) {
    throw new AppError("UNAUTHORIZED", "Missing or invalid API key. Use Authorization: Bearer srots_...");
  }

  const key = await db().apiKey.findUnique({
    where: { keyHash: hashApiKey(raw) },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  if (!key || key.revokedAt) {
    throw new AppError("UNAUTHORIZED", "API key is invalid or has been revoked.");
  }

  await db().apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);

  return {
    id: key.user.id,
    email: key.user.email,
    name: key.user.name,
    isAdmin: await isMainPerson(key.user),
  };
}
