import { z } from "zod";
import { authedRoute, ok, readJson } from "@/lib/api/handler";
import { RATE_LIMITS } from "@/lib/auth/rateLimit";
import { requestMeta } from "@/lib/esign/http";
import { resendInvitation } from "@/lib/esign/workflow";

type Params = { ref: string };

const schema = z.object({ recipientId: z.string().min(1).max(64) });

export const POST = authedRoute<Params>({ rateLimit: RATE_LIMITS.esignSend }, async ({ req, user, params }) => {
  const input = await readJson(req, schema);
  const result = await resendInvitation(user.id, params.ref, input.recipientId, { actor: `sender:${user.email}`, ...requestMeta(req) });
  return ok({ ok: result.ok, error: result.error ?? null });
});
