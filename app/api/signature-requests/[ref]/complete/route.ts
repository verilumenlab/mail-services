import { authedRoute, ok } from "@/lib/api/handler";
import { RATE_LIMITS } from "@/lib/auth/rateLimit";
import { AppError } from "@/lib/errors";
import { recordEventNow } from "@/lib/esign/audit";
import { finalizeRequest } from "@/lib/esign/finalize";
import { requestMeta } from "@/lib/esign/http";
import { getOwnedRequest } from "@/lib/esign/requests";

type Params = { ref: string };

/** Retries creating the final PDF and certificate for a request where everyone has signed. */
export const POST = authedRoute<Params>({ rateLimit: RATE_LIMITS.esignSend }, async ({ req, user, params }) => {
  const request = await getOwnedRequest(user.id, params.ref);
  if (request.status !== "PENDING") throw new AppError("INVALID_STATE", request.status === "COMPLETED" ? "This request is already complete." : "Not everyone has signed yet.");
  await recordEventNow({ actor: `sender:${user.email}`, ...requestMeta(req), requestId: request.id, userId: user.id, type: "FINALIZE_REQUESTED", message: "Sender asked to retry creating the final document" });
  const done = await finalizeRequest(request.id);
  const after = await getOwnedRequest(user.id, request.id);
  return ok({ completed: done, status: after.status, error: after.finalizeError });
});
