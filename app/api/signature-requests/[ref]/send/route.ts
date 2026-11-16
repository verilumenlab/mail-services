import { authedRoute, ok, readJson } from "@/lib/api/handler";
import { RATE_LIMITS } from "@/lib/auth/rateLimit";
import { requestMeta } from "@/lib/esign/http";
import { sendRequest } from "@/lib/esign/workflow";
import { sendRequestSchema } from "@/lib/validation/esign";

type Params = { ref: string };

export const POST = authedRoute<Params>({ rateLimit: RATE_LIMITS.esignSend }, async ({ req, user, params }) => {
  await readJson(req, sendRequestSchema);
  await sendRequest(user.id, params.ref, { actor: `sender:${user.email}`, ...requestMeta(req) });
  return ok({ ok: true });
});
