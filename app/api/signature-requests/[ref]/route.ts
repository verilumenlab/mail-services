import { authedRoute, ok, readJson } from "@/lib/api/handler";
import { requestMeta } from "@/lib/esign/http";
import { discardDraft, getOwnedRequest, publicRequest, readinessProblems, updateDraft } from "@/lib/esign/requests";
import { requestDraftSchema } from "@/lib/validation/esign";

type Params = { ref: string };

export const GET = authedRoute<Params>({}, async ({ user, params }) => {
  const req = await getOwnedRequest(user.id, params.ref);
  return ok({ request: publicRequest(req), problems: req.status === "DRAFT" ? readinessProblems(req) : [] });
});

export const PATCH = authedRoute<Params>({}, async ({ req, user, params }) => {
  const input = await readJson(req, requestDraftSchema);
  await updateDraft(user.id, params.ref, input, { actor: `sender:${user.email}`, ...requestMeta(req) });
  return ok({ ok: true });
});

export const DELETE = authedRoute<Params>({}, async ({ req, user, params }) => {
  await discardDraft(user.id, params.ref, { actor: `sender:${user.email}`, ...requestMeta(req) });
  return ok({ ok: true });
});
