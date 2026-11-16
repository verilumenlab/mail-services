import { z } from "zod";
import { ok, publicRoute, readJson } from "@/lib/api/handler";
import { RATE_LIMITS } from "@/lib/auth/rateLimit";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { requestMeta } from "@/lib/esign/http";
import { SIGNING_SESSION_MS } from "@/lib/esign/otp";
import { requireActiveSigner, sendOtp, sessionCookieName, verifyOtp } from "@/lib/esign/signer";

type Params = { ref: string };

const schema = z.object({
  channel: z.enum(["EMAIL", "SMS"]).default("EMAIL"),
  /** Omit to send a new code; include to check one. */
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code")
    .optional(),
});

export const POST = publicRoute<Params>({ rateLimit: RATE_LIMITS.signerOtp }, async ({ req, params }) => {
  const input = await readJson(req, schema);
  const ctx = await requireActiveSigner(params.ref);
  if (!ctx.me.consentAt) throw new AppError("INVALID_STATE", "Agree to sign electronically first.");
  const meta = requestMeta(req);
  if (!input.code) {
    const sent = await sendOtp(ctx, input.channel, meta);
    return ok({ sent: true, destination: sent.destination });
  }
  const result = await verifyOtp(ctx, input.channel, input.code, meta);
  const res = ok({ verified: true, sessionActive: Boolean(result.session), needSms: result.needSms });
  if (result.session) {
    res.cookies.set(sessionCookieName(ctx.me.id), result.session, {
      httpOnly: true,
      sameSite: "strict",
      secure: env().APP_URL.startsWith("https://"),
      path: "/api/signature-requests",
      maxAge: Math.floor(SIGNING_SESSION_MS / 1000),
    });
  }
  return res;
});
