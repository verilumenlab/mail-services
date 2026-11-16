import { z } from "zod";

export const externalSendSchema = z.object({
  to: z.string().trim().email("to must be a valid email"),
  subject: z.string().trim().min(1, "subject is required").max(998),
  body: z.string().min(1, "body is required").max(200_000),
  html: z.string().max(500_000).optional(),
  cc: z.array(z.string().trim().email()).max(20).optional(),
  fromName: z.string().trim().max(120).optional(),
});

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, "name is required").max(80),
});
