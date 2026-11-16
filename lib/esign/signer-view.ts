import "server-only";
import { CONSENT_TEXT, CONSENT_VERSION, signatureLevelLabel } from "./consent";
import { maskEmail, maskPhone } from "./otp";
import { hasSigningSession, problemText, verificationNeeded, type LinkProblem, type SignerCtx } from "./signer";

/** What the signing page may show. Never includes storage keys, other recipients' emails or tokens. */
export function signerView(ctx: SignerCtx | null, problem: LinkProblem | null, sessionCookie: string | undefined) {
  if (!ctx) return { problem: problem ?? "INVALID", problemText: problemText(problem ?? "INVALID") };
  const { req, me } = ctx;
  const signers = req.recipients.filter((r) => r.role !== "CC");
  const need = verificationNeeded(me);
  const limited = problem === "REVOKED" || problem === "CANCELLED" || problem === "REJECTED" || problem === "EXPIRED";
  return {
    problem,
    problemText: problem ? problemText(problem) : null,
    request: {
      title: req.title,
      documentTitle: req.version.document.title,
      senderName: req.senderName,
      senderEmail: req.senderEmail,
      senderCompany: req.senderCompany,
      message: limited ? null : req.message,
      expiresAt: req.expiresAt.toISOString(),
      status: req.status,
      pageCount: req.version.pageCount,
      documentSha256: limited ? null : req.documentSha256,
      finalSha256: req.status === "COMPLETED" ? req.finalSha256 : null,
      signatureLevel: signatureLevelLabel(req.signatureLevel),
      signingOrder: req.signingOrder,
      progress: { signed: signers.filter((r) => r.status === "SIGNED").length, total: signers.length },
    },
    me: {
      name: me.name,
      email: me.email,
      role: me.role,
      status: me.status,
      viewed: Boolean(me.viewedAt),
      reviewed: Boolean(me.reviewedAt),
      consented: Boolean(me.consentAt),
      emailVerified: !need.email,
      smsRequired: me.requireSmsOtp,
      smsVerified: !need.sms,
      emailDestination: maskEmail(me.email),
      smsDestination: me.phone ? maskPhone(me.phone) : null,
      sessionActive: hasSigningSession(me, sessionCookie),
      signedAt: me.signedAt?.toISOString() ?? null,
    },
    fields: limited
      ? []
      : req.fields
          .filter((f) => f.recipientId === me.id)
          .map((f) => ({ id: f.id, type: f.type, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, required: f.required, label: f.label })),
    consent: { version: CONSENT_VERSION, text: CONSENT_TEXT },
  };
}

export type SignerView = ReturnType<typeof signerView>;
