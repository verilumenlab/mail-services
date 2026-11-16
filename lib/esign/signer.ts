import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { randomToken } from "@/lib/crypto/tokens";
import { db } from "@/lib/database/prisma";
import { AppError } from "@/lib/errors";
import { recordEvent, recordEventNow, type Actor } from "./audit";
import { CONSENT_TEXT, CONSENT_VERSION } from "./consent";
import { otpEmail } from "./email-template";
import { finalizeRequest } from "./finalize";
import { normalizeSignatureImage } from "./image";
import { deliver, requestContext } from "./notify";
import { canSendOtp, checkOtpAttempt, generateOtp, hashOtp, maskEmail, maskPhone, OTP_SEND_WINDOW_MS, OTP_TTL_MS, otpMatches, SIGNING_SESSION_MS } from "./otp";
import { smsProvider } from "./sms";
import { advanceSigner, isTurnOf, OPEN_REQUEST, type RequestStatus } from "./status";
import { derivedSecret, getFile } from "./storage";
import { hashLinkToken, isLinkTokenShape, linkState } from "./tokens";
import { dispatchTurn, loadRequest, notifyRejected, notifySender, syncRequestStatus, type WorkflowRecipient, type WorkflowRequest } from "./workflow";

export type LinkProblem = "INVALID" | "REVOKED" | "EXPIRED" | "CANCELLED" | "REJECTED" | "COMPLETED" | "FINALIZING" | "SIGNED" | "NOT_YOUR_TURN";

export interface SignerCtx {
  req: WorkflowRequest;
  me: WorkflowRecipient;
}

const PROBLEM_TEXT: Record<LinkProblem, string> = {
  INVALID: "This signing link is not valid. Use the latest link from your email.",
  REVOKED: "This signing link was replaced or withdrawn. Use the latest link from your email.",
  EXPIRED: "This signing request has expired. Ask the sender to send it again.",
  CANCELLED: "The sender cancelled this signing request.",
  REJECTED: "This signing request was declined and is closed.",
  COMPLETED: "This document has been signed by everyone.",
  FINALIZING: "Everyone has signed. The final document is being prepared.",
  SIGNED: "You have already signed this document.",
  NOT_YOUR_TURN: "It is not your turn to sign yet. You will get an email when it is.",
};

export function problemText(p: LinkProblem): string {
  return PROBLEM_TEXT[p];
}

/** Finds the recipient for a link token and says whether they may act now. */
export async function resolveLink(token: string): Promise<{ problem: LinkProblem | null; ctx: SignerCtx | null }> {
  if (!isLinkTokenShape(token)) return { problem: "INVALID", ctx: null };
  const recipient = await db().signatureRecipient.findUnique({ where: { tokenHash: hashLinkToken(token) }, select: { id: true, requestId: true } });
  if (!recipient) return { problem: "INVALID", ctx: null };
  const req = await loadRequest(recipient.requestId);
  const me = req.recipients.find((r) => r.id === recipient.id)!;
  const ctx = { req, me };
  if (req.status === "COMPLETED") return { problem: "COMPLETED", ctx };
  if (req.status === "CANCELLED") return { problem: "CANCELLED", ctx };
  if (req.status === "REJECTED") return { problem: "REJECTED", ctx };
  if (req.status === "PENDING") return { problem: "FINALIZING", ctx };
  if (req.status === "EXPIRED" || req.status === "DRAFT") return { problem: req.status === "DRAFT" ? "INVALID" : "EXPIRED", ctx };
  const state = linkState({ revokedAt: me.tokenRevokedAt, expiresAt: req.expiresAt, now: new Date() });
  if (state !== "OK") return { problem: state, ctx };
  if (me.status === "SIGNED") return { problem: "SIGNED", ctx };
  if (me.role === "CC" || !isTurnOf(req.signingOrder, req.recipients, me.id)) return { problem: "NOT_YOUR_TURN", ctx };
  return { problem: null, ctx };
}

export async function requireActiveSigner(token: string): Promise<SignerCtx> {
  const { problem, ctx } = await resolveLink(token);
  if (problem || !ctx) throw new AppError(problem === "INVALID" ? "NOT_FOUND" : "INVALID_STATE", PROBLEM_TEXT[problem ?? "INVALID"], { problem });
  return ctx;
}

function actorFor(me: WorkflowRecipient, meta: { ip: string | null; userAgent: string | null }): Actor {
  return { actor: `signer:${me.email}`, ip: meta.ip, userAgent: meta.userAgent };
}

export function sessionCookieName(recipientId: string): string {
  return `esign_s_${recipientId}`;
}

function sessionHash(value: string): string {
  return createHmac("sha256", derivedSecret("signing-session-v1")).update(value).digest("hex");
}

export function hasSigningSession(me: WorkflowRecipient, cookieValue: string | undefined | null): boolean {
  if (!cookieValue || !me.signingSessionHash || !me.signingSessionUntil) return false;
  if (me.signingSessionUntil.getTime() <= Date.now()) return false;
  const a = Buffer.from(sessionHash(cookieValue), "hex");
  const b = Buffer.from(me.signingSessionHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verificationNeeded(me: WorkflowRecipient): { email: boolean; sms: boolean } {
  return { email: !me.emailVerifiedAt, sms: me.requireSmsOtp && !me.smsVerifiedAt };
}

export async function markViewed(ctx: SignerCtx, meta: { ip: string | null; userAgent: string | null }) {
  if (ctx.me.viewedAt) return;
  const claimed = await db().$transaction(async (tx) => {
    const res = await tx.signatureRecipient.updateMany({ where: { id: ctx.me.id, viewedAt: null }, data: { viewedAt: new Date(), status: advanceSigner(ctx.me.status, "VIEWED") } });
    if (res.count !== 1) return false;
    await recordEvent(tx, { ...actorFor(ctx.me, meta), requestId: ctx.req.id, userId: ctx.req.userId, recipientId: ctx.me.id, type: "DOCUMENT_VIEWED", message: `${ctx.me.name} opened the document` });
    await syncRequestStatus(tx, ctx.req.id);
    return true;
  });
  if (claimed) await notifySender(ctx.req, "VIEWED", { who: `${ctx.me.name} (${ctx.me.email})` });
}

export async function markReviewed(ctx: SignerCtx, pagesSeen: number, meta: { ip: string | null; userAgent: string | null }) {
  if (ctx.me.reviewedAt) return;
  await db().$transaction(async (tx) => {
    const res = await tx.signatureRecipient.updateMany({ where: { id: ctx.me.id, reviewedAt: null }, data: { reviewedAt: new Date(), status: advanceSigner(ctx.me.status, "IN_REVIEW") } });
    if (res.count !== 1) return;
    await recordEvent(tx, {
      ...actorFor(ctx.me, meta),
      requestId: ctx.req.id,
      userId: ctx.req.userId,
      recipientId: ctx.me.id,
      type: "DOCUMENT_REVIEWED",
      message: `${ctx.me.name} scrolled through all ${pagesSeen} page${pagesSeen === 1 ? "" : "s"}`,
      metadata: { pagesSeen, pageCount: ctx.req.version.pageCount },
    });
    await syncRequestStatus(tx, ctx.req.id);
  });
}

export async function recordConsent(ctx: SignerCtx, meta: { ip: string | null; userAgent: string | null }) {
  if (ctx.me.consentAt) return;
  if (!ctx.me.reviewedAt) throw new AppError("INVALID_STATE", "Review every page of the document before agreeing to sign.");
  await db().$transaction(async (tx) => {
    const res = await tx.signatureRecipient.updateMany({
      where: { id: ctx.me.id, consentAt: null },
      data: { consentAt: new Date(), consentText: `[${CONSENT_VERSION}] ${CONSENT_TEXT}`, consentIp: meta.ip, consentUserAgent: meta.userAgent },
    });
    if (res.count !== 1) return;
    await recordEvent(tx, {
      ...actorFor(ctx.me, meta),
      requestId: ctx.req.id,
      userId: ctx.req.userId,
      recipientId: ctx.me.id,
      type: "CONSENT_GIVEN",
      message: `${ctx.me.name} agreed to use electronic records and signatures`,
      metadata: { consentVersion: CONSENT_VERSION },
    });
  });
}

export async function rejectRequest(ctx: SignerCtx, reason: string, meta: { ip: string | null; userAgent: string | null }) {
  const now = new Date();
  await db().$transaction(async (tx) => {
    const claimed = await tx.signatureRequest.updateMany({ where: { id: ctx.req.id, status: { in: OPEN_REQUEST } }, data: { status: "REJECTED", rejectedAt: now } });
    if (claimed.count !== 1) throw new AppError("CONFLICT", "This request is no longer open.");
    await tx.signatureRecipient.update({ where: { id: ctx.me.id }, data: { status: "REJECTED", rejectedAt: now, rejectReason: reason, signingSessionHash: null, signingSessionUntil: null } });
    await tx.signatureRecipient.updateMany({ where: { requestId: ctx.req.id, id: { not: ctx.me.id }, status: { notIn: ["SIGNED"] } }, data: { status: "CANCELLED" } });
    await tx.signatureRecipient.updateMany({ where: { requestId: ctx.req.id, tokenRevokedAt: null }, data: { tokenRevokedAt: now } });
    await recordEvent(tx, {
      ...actorFor(ctx.me, meta),
      requestId: ctx.req.id,
      userId: ctx.req.userId,
      recipientId: ctx.me.id,
      type: "REQUEST_REJECTED",
      message: `${ctx.me.name} declined to sign: ${reason}`,
      metadata: { reason },
    });
  });
  const fresh = await loadRequest(ctx.req.id);
  await notifyRejected(fresh, fresh.recipients.find((r) => r.id === ctx.me.id)!);
}

export async function sendOtp(ctx: SignerCtx, channel: "EMAIL" | "SMS", meta: { ip: string | null; userAgent: string | null }) {
  const me = ctx.me;
  if (channel === "SMS" && (!me.requireSmsOtp || !me.phone)) throw new AppError("VALIDATION", "SMS verification is not required for you.");
  const sms = channel === "SMS" ? smsProvider() : null;
  if (channel === "SMS" && !sms) throw new AppError("NOT_CONFIGURED", "SMS verification is not available. Ask the sender to contact support.");
  const now = new Date();
  const recent = await db().verificationAttempt.findMany({
    where: { recipientId: me.id, channel, createdAt: { gte: new Date(now.getTime() - OTP_SEND_WINDOW_MS) } },
    select: { createdAt: true },
  });
  if (!canSendOtp(recent.map((r) => r.createdAt), now)) throw new AppError("RATE_LIMITED", "Too many codes requested. Wait 15 minutes and try again.");
  const code = generateOtp();
  const destination = channel === "EMAIL" ? maskEmail(me.email) : maskPhone(me.phone!);
  await db().$transaction(async (tx) => {
    await tx.verificationAttempt.updateMany({ where: { recipientId: me.id, channel, outcome: "PENDING" }, data: { outcome: "EXPIRED" } });
    await tx.verificationAttempt.create({
      data: {
        recipientId: me.id,
        channel,
        codeHash: hashOtp(derivedSecret("otp-v1"), me.id, channel, code),
        destination,
        expiresAt: new Date(now.getTime() + OTP_TTL_MS),
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });
  });
  if (channel === "EMAIL") {
    const result = await deliver({ userId: ctx.req.userId, requestId: ctx.req.id, recipientId: me.id, kind: "OTP", to: me.email, fromName: ctx.req.senderName, content: otpEmail(requestContext(ctx.req), me, code) });
    if (!result.ok) throw new AppError("PROVIDER_ERROR", "The code email could not be sent. Try again in a minute.");
  } else {
    await sms!.sendOtp(me.phone!, code, { documentTitle: ctx.req.version.document.title });
  }
  await recordEventNow({ ...actorFor(me, meta), requestId: ctx.req.id, userId: ctx.req.userId, recipientId: me.id, type: "OTP_SENT", message: `One-time code sent by ${channel === "EMAIL" ? "email" : "SMS"} to ${destination}` });
  return { destination };
}

/** Checks a code. When every required channel is verified, opens a short signing session and returns its cookie value. */
export async function verifyOtp(ctx: SignerCtx, channel: "EMAIL" | "SMS", code: string, meta: { ip: string | null; userAgent: string | null }) {
  const me = ctx.me;
  const latest = await db().verificationAttempt.findFirst({ where: { recipientId: me.id, channel, outcome: "PENDING" }, orderBy: { createdAt: "desc" } });
  if (!latest) throw new AppError("VALIDATION", "Request a new code first.");
  const bumped = await db().verificationAttempt.update({ where: { id: latest.id }, data: { attempts: { increment: 1 } } });
  const now = new Date();
  const result = checkOtpAttempt({ matches: otpMatches(derivedSecret("otp-v1"), me.id, channel, code, latest.codeHash), attempts: bumped.attempts, expiresAt: latest.expiresAt, now });
  const base = { ...actorFor(me, meta), requestId: ctx.req.id, userId: ctx.req.userId, recipientId: me.id };
  if (result !== "OK") {
    const outcome = result === "EXPIRED" ? "EXPIRED" : result === "LOCKED" ? "LOCKED" : "PENDING";
    await db().$transaction(async (tx) => {
      if (outcome !== "PENDING") await tx.verificationAttempt.update({ where: { id: latest.id }, data: { outcome } });
      await recordEvent(tx, { ...base, type: "OTP_FAILED", message: `Wrong or expired ${channel === "EMAIL" ? "email" : "SMS"} code (${result.toLowerCase()})`, metadata: { attempts: bumped.attempts } });
    });
    const text = result === "EXPIRED" ? "This code has expired. Request a new one." : result === "LOCKED" ? "Too many wrong codes. Request a new code." : "That code is not correct.";
    throw new AppError("VALIDATION", text, { result });
  }
  const verifiedAt = new Date();
  const session = randomToken(32);
  const updated = await db().$transaction(async (tx) => {
    await tx.verificationAttempt.update({ where: { id: latest.id }, data: { outcome: "VERIFIED", verifiedAt } });
    const r = await tx.signatureRecipient.update({ where: { id: me.id }, data: channel === "EMAIL" ? { emailVerifiedAt: verifiedAt } : { smsVerifiedAt: verifiedAt } });
    const done = Boolean(r.emailVerifiedAt) && (!r.requireSmsOtp || Boolean(r.smsVerifiedAt));
    if (done) await tx.signatureRecipient.update({ where: { id: me.id }, data: { signingSessionHash: sessionHash(session), signingSessionUntil: new Date(verifiedAt.getTime() + SIGNING_SESSION_MS) } });
    await recordEvent(tx, { ...base, type: "IDENTITY_VERIFIED", message: `${me.name} confirmed the ${channel === "EMAIL" ? "email" : "SMS"} one-time code`, metadata: { channel, destination: latest.destination } });
    return { done, needSms: r.requireSmsOtp && !r.smsVerifiedAt };
  });
  return { session: updated.done ? session : null, needSms: updated.needSms };
}

function formatSignDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export interface SignInput {
  signature: { method: "DRAWN" | "UPLOADED" | "TYPED"; image: string; initialsImage?: string; typedName?: string; fontStyle?: string };
  values: Record<string, string>;
  documentSha256: string;
}

export async function signDocument(ctx: SignerCtx, input: SignInput, sessionValue: string | undefined, meta: { ip: string | null; userAgent: string | null }) {
  const { req, me } = ctx;
  if (!me.reviewedAt) throw new AppError("INVALID_STATE", "Review every page of the document first.");
  if (!me.consentAt) throw new AppError("INVALID_STATE", "Agree to sign electronically first.");
  const need = verificationNeeded(me);
  if (need.email || need.sms) throw new AppError("FORBIDDEN", "Confirm your one-time code first.");
  if (!hasSigningSession(me, sessionValue)) throw new AppError("FORBIDDEN", "Your verification has expired. Request a new code to continue.");
  if (!req.documentSha256 || input.documentSha256 !== req.documentSha256) throw new AppError("CONFLICT", "The document changed since you opened it. Reload the page.");
  await getFile(req.version.pdfKey, req.documentSha256);

  const signature = await normalizeSignatureImage(input.signature.image);
  const myFields = req.fields.filter((f) => f.recipientId === me.id);
  const needsInitials = myFields.some((f) => f.type === "INITIALS");
  const initials = needsInitials && input.signature.initialsImage ? await normalizeSignatureImage(input.signature.initialsImage, "initials") : null;
  const now = new Date();
  const values = new Map<string, string | null>();
  for (const f of myFields) {
    if (f.type === "DATE") values.set(f.id, formatSignDate(now));
    else if (f.type === "NAME") values.set(f.id, me.name);
    else if (f.type === "INITIALS") values.set(f.id, initials ? `data:image/png;base64,${initials.png.toString("base64")}` : null);
    else if (f.type === "TEXT") {
      const v = (input.values[f.id] ?? "").trim().slice(0, 500);
      if (f.required && !v) throw new AppError("VALIDATION", `Fill in "${f.label || "the text field"}" before signing.`);
      values.set(f.id, v || null);
    }
  }
  if (needsInitials && !initials && myFields.some((f) => f.type === "INITIALS" && f.required)) throw new AppError("VALIDATION", "Add your initials before signing.");

  const status = await db().$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ status: RequestStatus }[]>`SELECT status::text AS status FROM signature_requests WHERE id = ${req.id} FOR UPDATE`;
    if (!locked[0] || !OPEN_REQUEST.includes(locked[0].status)) throw new AppError("CONFLICT", "This request is no longer open for signing.");
    const claimed = await tx.signatureRecipient.updateMany({
      where: { id: me.id, status: { notIn: ["SIGNED", "REJECTED", "CANCELLED", "EXPIRED"] }, tokenRevokedAt: null },
      data: { status: "SIGNED", signedAt: now, signingSessionHash: null, signingSessionUntil: null },
    });
    if (claimed.count !== 1) throw new AppError("CONFLICT", "You have already signed this document.");
    await tx.signature.create({
      data: {
        requestId: req.id,
        recipientId: me.id,
        method: input.signature.method,
        image: new Uint8Array(signature.png),
        typedName: input.signature.method === "TYPED" ? input.signature.typedName?.slice(0, 120) ?? me.name : null,
        fontStyle: input.signature.method === "TYPED" ? input.signature.fontStyle?.slice(0, 60) ?? null : null,
        signerName: me.name,
        signerEmail: me.email,
        ip: meta.ip,
        userAgent: meta.userAgent,
        documentSha256: req.documentSha256!,
      },
    });
    for (const [id, value] of values) await tx.signatureField.update({ where: { id }, data: { value } });
    await recordEvent(tx, {
      ...actorFor(me, meta),
      requestId: req.id,
      userId: req.userId,
      recipientId: me.id,
      type: "SIGNED",
      message: `${me.name} ${me.role === "APPROVER" ? "approved and signed" : "signed"} electronically (${input.signature.method.toLowerCase()} signature)`,
      metadata: { method: input.signature.method, documentSha256: req.documentSha256, fields: myFields.length },
    });
    return syncRequestStatus(tx, req.id);
  });

  if (status === "PENDING") {
    await finalizeRequest(req.id).catch((err) => console.error("[esign] finalize after last signature failed", err));
  } else {
    const fresh = await loadRequest(req.id);
    const signers = fresh.recipients.filter((r) => r.role !== "CC");
    await notifySender(fresh, "PARTIALLY_SIGNED", { who: `${me.name} (${me.email})`, signed: signers.filter((r) => r.status === "SIGNED").length, total: signers.length });
    await dispatchTurn(req.id);
  }
  return { status };
}
