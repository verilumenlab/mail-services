import { ok, publicRoute, readJson } from "@/lib/api/handler";
import { RATE_LIMITS } from "@/lib/auth/rateLimit";
import { requestMeta } from "@/lib/esign/http";
import { recordConsent, requireActiveSigner } from "@/lib/esign/signer";
import { consentSchema } from "@/lib/validation/esign";

type Params = { ref: string };

export const POST = publicRoute<Params>({ rateLimit: RATE_LIMITS.signerAction }, async ({ req, params }) => {
  await readJson(req, consentSchema);
  const ctx = await requireActiveSigner(params.ref);
  await recordConsent(ctx, requestMeta(req));
  return ok({ ok: true });
});
