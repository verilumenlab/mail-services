import { apiKeyRoute, ok, readJson } from "@/lib/api/handler";
import { RATE_LIMITS } from "@/lib/auth/rateLimit";
import { providerForAccount } from "@/lib/email";
import { AppError } from "@/lib/errors";
import { getActiveEmailAccount } from "@/lib/services/providers";
import { logActivity } from "@/lib/services/logs";
import { externalSendSchema } from "@/lib/validation/send-api";
import { ProviderError } from "@/lib/email/provider";

/**
 * External transactional send for other applications.
 * Auth: Authorization: Bearer srots_...
 */
export const POST = apiKeyRoute({ rateLimit: RATE_LIMITS.send }, async ({ req, user }) => {
  const input = await readJson(req, externalSendSchema);
  const account = await getActiveEmailAccount(user.id);
  if (!account) {
    throw new AppError("NOT_CONFIGURED", "Connect a sending account (Gmail or SMTP) in Settings before using the send API.");
  }

  try {
    const result = await providerForAccount(account).sendEmail({
      from: { email: account.email, name: input.fromName ?? account.displayName },
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      body: input.body,
      html: input.html,
    });

    await logActivity({
      category: "EMAIL_SEND",
      userId: user.id,
      message: `API send to ${input.to}`,
      metadata: { providerMessageId: result.providerMessageId, subject: input.subject },
    });

    return ok({
      id: result.providerMessageId,
      to: input.to,
      subject: input.subject,
      from: account.email,
    });
  } catch (err) {
    if (err instanceof ProviderError) {
      const code =
        err.kind === "AUTH"
          ? "PROVIDER_AUTH"
          : err.kind === "RATE_LIMIT"
            ? "PROVIDER_RATE_LIMIT"
            : err.kind === "INVALID_RECIPIENT"
              ? "VALIDATION"
              : "PROVIDER_ERROR";
      throw new AppError(code, err.message);
    }
    throw err;
  }
});
