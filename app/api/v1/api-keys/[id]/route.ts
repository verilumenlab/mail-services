import { authedRoute, ok } from "@/lib/api/handler";
import { RATE_LIMITS } from "@/lib/auth/rateLimit";
import { db } from "@/lib/database/prisma";
import { AppError } from "@/lib/errors";

type Params = { id: string };

export const DELETE = authedRoute<Params>({ rateLimit: RATE_LIMITS.api }, async ({ user, params }) => {
  const key = await db().apiKey.findFirst({ where: { id: params.id, userId: user.id } });
  if (!key) throw new AppError("NOT_FOUND", "API key not found.");
  if (key.revokedAt) return ok({ ok: true, alreadyRevoked: true });

  await db().apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
  return ok({ ok: true });
});
