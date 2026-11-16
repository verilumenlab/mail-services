import { authedRoute, ok, readJson } from "@/lib/api/handler";
import { AppError } from "@/lib/errors";
import { requestMeta } from "@/lib/esign/http";
import { getOwnedRequest, publicField, readinessProblems, replaceFields } from "@/lib/esign/requests";
import { fieldsSchema } from "@/lib/validation/esign";

export const GET = authedRoute({}, async ({ req, user }) => {
  const requestId = req.nextUrl.searchParams.get("requestId");
  if (!requestId) throw new AppError("VALIDATION", "requestId is required.");
  const request = await getOwnedRequest(user.id, requestId);
  return ok({ fields: request.fields.map(publicField) });
});

/** Replaces every field of one draft request. */
export const PUT = authedRoute({}, async ({ req, user }) => {
  const input = await readJson(req, fieldsSchema);
  await replaceFields(user.id, input.requestId, input.fields, { actor: `sender:${user.email}`, ...requestMeta(req) });
  const request = await getOwnedRequest(user.id, input.requestId);
  return ok({ fields: request.fields.map(publicField), problems: readinessProblems(request) });
});
