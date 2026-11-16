import { authedRoute, ok, readJson } from "@/lib/api/handler";
import { generateApiKey } from "@/lib/api/api-key";
import { RATE_LIMITS } from "@/lib/auth/rateLimit";
import { db } from "@/lib/database/prisma";
import { AppError } from "@/lib/errors";
import { createApiKeySchema } from "@/lib/validation/send-api";

export const GET = authedRoute({ rateLimit: RATE_LIMITS.api }, async ({ user }) => {
  const keys = await db().apiKey.findMany({
    where: { userId: user.id, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, keyPrefix: true, lastUsedAt: true, createdAt: true },
  });
  return ok({
    items: keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.keyPrefix,
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      createdAt: k.createdAt.toISOString(),
    })),
  });
});

export const POST = authedRoute({ rateLimit: RATE_LIMITS.api }, async ({ req, user }) => {
  const input = await readJson(req, createApiKeySchema);
  const existing = await db().apiKey.count({ where: { userId: user.id, revokedAt: null } });
  if (existing >= 10) {
    throw new AppError("INVALID_STATE", "You can have at most 10 active API keys. Revoke one first.");
  }

  const generated = generateApiKey();
  const created = await db().apiKey.create({
    data: {
      userId: user.id,
      name: input.name,
      keyHash: generated.hash,
      keyPrefix: generated.prefix,
    },
    select: { id: true, name: true, keyPrefix: true, createdAt: true },
  });

  return ok({
    id: created.id,
    name: created.name,
    prefix: created.keyPrefix,
    createdAt: created.createdAt.toISOString(),
    /** Shown only once — store it securely. */
    key: generated.raw,
  });
});
