import { z } from "zod";

const noBreaks = (s: string) => !/[\r\n]/.test(s);

export const documentTitleSchema = z.string().trim().max(200).refine(noBreaks, "Title cannot contain line breaks");

export const renameDocumentSchema = z.object({ title: documentTitleSchema.pipe(z.string().min(1, "Title is required")) });

export const recipientSchema = z.object({
  name: z.string().trim().min(1, "Recipient name is required").max(120).refine(noBreaks, "Name cannot contain line breaks"),
  email: z.string().trim().toLowerCase().email("Enter a valid recipient email address").max(254),
  role: z.enum(["SIGNER", "APPROVER", "CC"]),
  routingOrder: z.number().int().min(1).max(50),
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/, "Phone must be in international format, for example +919876543210")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  requireSmsOtp: z.boolean().optional(),
});

export const requestDraftSchema = z
  .object({
    documentVersionId: z.string().min(1).max(64),
    title: z.string().trim().min(1, "Title is required").max(200).refine(noBreaks, "Title cannot contain line breaks"),
    subject: z.string().trim().max(200).refine(noBreaks, "Subject cannot contain line breaks").optional(),
    message: z.string().trim().max(5000).optional(),
    signingOrder: z.enum(["SEQUENTIAL", "PARALLEL"]),
    expiresInDays: z.number().int().min(1).max(365),
    reminderEveryDays: z.number().int().min(0).max(30),
    senderCompany: z.string().trim().max(160).optional(),
    recipients: z.array(recipientSchema).min(1, "Add at least one recipient").max(25, "At most 25 recipients"),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.recipients.forEach((r, i) => {
      if (seen.has(r.email)) ctx.addIssue({ code: "custom", path: ["recipients", i, "email"], message: `${r.email} is listed twice` });
      seen.add(r.email);
      if (r.requireSmsOtp && !r.phone) ctx.addIssue({ code: "custom", path: ["recipients", i, "phone"], message: "SMS verification needs a phone number" });
    });
    if (!v.recipients.some((r) => r.role !== "CC")) {
      ctx.addIssue({ code: "custom", path: ["recipients"], message: "Add at least one signer or approver" });
    }
  });

export type RequestDraftInput = z.infer<typeof requestDraftSchema>;

const unit = z.number().finite().min(0).max(1);

export const fieldSchema = z.object({
  recipientId: z.string().min(1).max(64),
  type: z.enum(["SIGNATURE", "INITIALS", "DATE", "NAME", "TEXT"]),
  page: z.number().int().min(1).max(500),
  x: unit,
  y: unit,
  width: unit.refine((n) => n >= 0.01, "Field is too small"),
  height: unit.refine((n) => n >= 0.01, "Field is too small"),
  required: z.boolean(),
  label: z.string().trim().max(80).optional(),
});

export const fieldsSchema = z.object({ requestId: z.string().min(1).max(64), fields: z.array(fieldSchema).max(500) });
export type FieldInput = z.infer<typeof fieldSchema>;

export const sendRequestSchema = z.object({ confirm: z.literal(true, { message: "Confirm before sending." }) });

export const cancelRequestSchema = z.object({ reason: z.string().trim().max(500).optional() });

export const consentSchema = z.object({ agree: z.literal(true, { message: "You must agree to sign electronically." }) });

export const otpRequestSchema = z.object({ channel: z.enum(["EMAIL", "SMS"]).default("EMAIL") });

export const otpVerifySchema = z.object({
  channel: z.enum(["EMAIL", "SMS"]).default("EMAIL"),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"),
});

export const signatureInputSchema = z.object({
  method: z.enum(["DRAWN", "UPLOADED", "TYPED"]),
  /** PNG data URL for drawn and uploaded signatures, rendered PNG for typed ones. */
  image: z.string().max(1_500_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, "Signature image must be a PNG"),
  initialsImage: z
    .string()
    .max(1_500_000)
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, "Initials image must be a PNG")
    .optional(),
  typedName: z.string().trim().max(120).optional(),
  fontStyle: z.string().trim().max(60).optional(),
});

export const signSchema = z.object({
  signature: signatureInputSchema,
  values: z.record(z.string().min(1).max(64), z.string().max(500)).default({}),
  documentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  agree: z.literal(true, { message: "Confirm that you intend to sign." }),
});

export const rejectSchema = z.object({ reason: z.string().trim().min(3, "Tell the sender why you are declining").max(1000) });
