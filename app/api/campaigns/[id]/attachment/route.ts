import { authedRoute, ok } from "@/lib/api/handler";
import { RATE_LIMITS } from "@/lib/auth/rateLimit";
import { ATTACHMENT_MAX_BYTES } from "@/lib/email/attachment";
import { AppError } from "@/lib/errors";
import { clearCampaignAttachment, setCampaignAttachment } from "@/lib/services/bulk";

type Params = { id: string };

export const POST = authedRoute<Params>({ rateLimit: RATE_LIMITS.api }, async ({ req, user, params }) => {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("VALIDATION", "Choose a file to attach.");
  if (file.size > ATTACHMENT_MAX_BYTES) throw new AppError("VALIDATION", "The file is larger than 100 MB.");
  const attachment = await setCampaignAttachment(user.id, params.id, file.name, new Uint8Array(await file.arrayBuffer()));
  return ok({ attachment });
});

export const DELETE = authedRoute<Params>({ rateLimit: RATE_LIMITS.api }, async ({ user, params }) => {
  await clearCampaignAttachment(user.id, params.id);
  return ok({ attachment: null });
});
