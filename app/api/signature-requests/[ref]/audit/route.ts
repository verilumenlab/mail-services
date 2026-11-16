import { authedRoute, ok } from "@/lib/api/handler";
import { auditTrail } from "@/lib/esign/audit";
import { getOwnedRequest } from "@/lib/esign/requests";

type Params = { ref: string };

/** The tamper-evident audit trail of one request. Only the request owner can read it. */
export const GET = authedRoute<Params>({}, async ({ user, params }) => {
  const request = await getOwnedRequest(user.id, params.ref);
  const { rows, integrity } = await auditTrail(request.id);
  const res = ok({
    integrity,
    entries: rows.map((r) => ({
      id: r.id,
      action: r.action,
      actor: r.actor,
      recipientId: r.recipientId,
      ip: r.ip,
      userAgent: r.userAgent,
      details: r.details,
      createdAt: r.createdAt,
      hash: r.hash,
      prevHash: r.prevHash,
    })),
  });
  res.headers.set("Cache-Control", "private, no-store");
  return res;
});
