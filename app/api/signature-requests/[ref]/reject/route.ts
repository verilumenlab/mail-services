import { ok, publicRoute, readJson } from "@/lib/api/handler";
import { RATE_LIMITS } from "@/lib/auth/rateLimit";
import { requestMeta } from "@/lib/esign/http";
import { rejectRequest, requireActiveSigner } from "@/lib/esign/signer";
import { rejectSchema } from "@/lib/validation/esign";

type Params = { ref: string };

export const POST = publicRoute<Params>({ rateLimit: RATE_LIMITS.signerAction }, async ({ req, params }) => {
  const input = await readJson(req, rejectSchema);
  const ctx = await requireActiveSigner(params.ref);
  await rejectRequest(ctx, input.reason, requestMeta(req));
  return ok({ ok: true });
});
