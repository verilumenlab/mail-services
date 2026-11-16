import { z } from "zod";
import { ok, publicRoute, readJson } from "@/lib/api/handler";
import { RATE_LIMITS } from "@/lib/auth/rateLimit";
import { AppError } from "@/lib/errors";
import { requestMeta } from "@/lib/esign/http";
import { markReviewed, markViewed, requireActiveSigner, resolveLink, sessionCookieName } from "@/lib/esign/signer";
import { signerView } from "@/lib/esign/signer-view";

type Params = { ref: string };

/** Recipient view of a request, authorised by the link token in `ref`. Opening it records VIEWED. */
export const GET = publicRoute<Params>({ rateLimit: RATE_LIMITS.signerView }, async ({ req, params }) => {
  let { problem, ctx } = await resolveLink(params.ref);
  if (problem === "INVALID" || !ctx) throw new AppError("NOT_FOUND", "This signing link is not valid. Use the latest link from your email.");
  if (!problem) {
    await markViewed(ctx, requestMeta(req));
    ({ problem, ctx } = await resolveLink(params.ref));
  }
  const res = ok(signerView(ctx, problem, ctx ? req.cookies.get(sessionCookieName(ctx.me.id))?.value : undefined));
  res.headers.set("Cache-Control", "private, no-store");
  return res;
});

const reviewedSchema = z.object({ pagesSeen: z.number().int().min(1).max(1000) });

/** The recipient scrolled through every page. */
export const POST = publicRoute<Params>({ rateLimit: RATE_LIMITS.signerAction }, async ({ req, params }) => {
  const input = await readJson(req, reviewedSchema);
  const ctx = await requireActiveSigner(params.ref);
  if (input.pagesSeen < ctx.req.version.pageCount) throw new AppError("VALIDATION", "Review every page before continuing.");
  await markReviewed(ctx, input.pagesSeen, requestMeta(req));
  return ok({ ok: true });
});
