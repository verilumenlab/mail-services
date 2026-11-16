import { ok, publicRoute, readJson } from "@/lib/api/handler";
import { RATE_LIMITS } from "@/lib/auth/rateLimit";
import { requestMeta } from "@/lib/esign/http";
import { requireActiveSigner, sessionCookieName, signDocument } from "@/lib/esign/signer";
import { signSchema } from "@/lib/validation/esign";

type Params = { ref: string };

export const POST = publicRoute<Params>({ rateLimit: RATE_LIMITS.signerAction }, async ({ req, params }) => {
  const input = await readJson(req, signSchema);
  const ctx = await requireActiveSigner(params.ref);
  const result = await signDocument(ctx, input, req.cookies.get(sessionCookieName(ctx.me.id))?.value, requestMeta(req));
  const res = ok({ ok: true, status: result.status });
  res.cookies.delete({ name: sessionCookieName(ctx.me.id), path: "/api/signature-requests" });
  return res;
});
