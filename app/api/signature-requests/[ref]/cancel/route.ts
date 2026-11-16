import { authedRoute, ok, readJson } from "@/lib/api/handler";
import { requestMeta } from "@/lib/esign/http";
import { cancelRequest } from "@/lib/esign/workflow";
import { cancelRequestSchema } from "@/lib/validation/esign";

type Params = { ref: string };

export const POST = authedRoute<Params>({}, async ({ req, user, params }) => {
  const input = await readJson(req, cancelRequestSchema);
  await cancelRequest(user.id, params.ref, input.reason || null, { actor: `sender:${user.email}`, ...requestMeta(req) });
  return ok({ ok: true });
});
