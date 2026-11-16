import { authedRoute, ok } from "@/lib/api/handler";
import { RATE_LIMITS } from "@/lib/auth/rateLimit";
import { requestMeta } from "@/lib/esign/http";
import { remindNow } from "@/lib/esign/workflow";

type Params = { ref: string };

export const POST = authedRoute<Params>({ rateLimit: RATE_LIMITS.esignSend }, async ({ req, user, params }) => {
  const result = await remindNow(user.id, params.ref, { actor: `sender:${user.email}`, ...requestMeta(req) });
  return ok(result);
});
