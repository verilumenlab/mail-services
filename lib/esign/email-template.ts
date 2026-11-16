export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

interface LayoutInput {
  appUrl: string;
  preheader: string;
  brand: string;
  heading: string;
  paragraphs: string[];
  /** Plain text quoted as the sender's message. */
  quote?: { from: string; text: string } | null;
  details?: [string, string][];
  button?: { label: string; url: string } | null;
  code?: string | null;
  footer: string[];
}

function layout(input: LayoutInput): { html: string; text: string } {
  const e = escapeHtml;
  const details = input.details?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:20px 0;border-collapse:collapse">${input.details
        .map(
          ([k, v]) =>
            `<tr><td style="padding:6px 0;color:#64748b;font-size:13px;width:38%;vertical-align:top">${e(k)}</td><td style="padding:6px 0;color:#0f172a;font-size:13px;vertical-align:top">${e(v)}</td></tr>`,
        )
        .join("")}</table>`
    : "";
  const quote = input.quote
    ? `<div style="margin:20px 0;padding:14px 16px;border-left:3px solid #2563eb;background:#f1f5f9;border-radius:4px"><p style="margin:0 0 6px;color:#64748b;font-size:12px">Message from ${e(input.quote.from)}</p><p style="margin:0;color:#0f172a;font-size:14px;line-height:1.6;white-space:pre-wrap">${e(input.quote.text)}</p></div>`
    : "";
  const button = input.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0"><tr><td style="border-radius:8px;background:#2563eb"><a href="${e(input.button.url)}" style="display:inline-block;padding:15px 34px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${e(input.button.label)}</a></td></tr></table><p style="margin:0 0 8px;color:#64748b;font-size:12px;line-height:1.5">If the button does not work, copy this link into your browser:<br><a href="${e(input.button.url)}" style="color:#2563eb;word-break:break-all">${e(input.button.url)}</a></p>`
    : "";
  const code = input.code
    ? `<p style="margin:24px 0;font-size:32px;letter-spacing:10px;font-weight:700;color:#0f172a;font-family:ui-monospace,Menlo,Consolas,monospace">${e(input.code)}</p>`
    : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${e(input.heading)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${e(input.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0">
<tr><td style="padding:22px 28px;border-bottom:1px solid #e2e8f0"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding-right:10px"><img src="${e(input.appUrl)}/brand/sorts-mark-512.png" width="28" height="28" alt="" style="display:block;border:0"></td><td style="font-size:15px;font-weight:600;color:#0f172a">${e(input.brand)}</td></tr></table></td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#0f172a">${e(input.heading)}</h1>
${input.paragraphs.map((p) => `<p style="margin:0 0 12px;color:#334155;font-size:15px;line-height:1.6">${e(p)}</p>`).join("")}
${quote}${details}${code}${button}
</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #e2e8f0;background:#f8fafc;border-radius:0 0 12px 12px">
${input.footer.map((f) => `<p style="margin:0 0 6px;color:#64748b;font-size:12px;line-height:1.5">${e(f)}</p>`).join("")}
</td></tr></table></td></tr></table></body></html>`;
  const text = [
    input.heading,
    "",
    ...input.paragraphs,
    ...(input.quote ? ["", `Message from ${input.quote.from}:`, input.quote.text] : []),
    ...(input.details?.length ? ["", ...input.details.map(([k, v]) => `${k}: ${v}`)] : []),
    ...(input.code ? ["", `Code: ${input.code}`] : []),
    ...(input.button ? ["", `${input.button.label}: ${input.button.url}`] : []),
    "",
    ...input.footer,
  ].join("\n");
  return { html, text };
}

export interface RequestContext {
  appUrl: string;
  title: string;
  documentTitle: string;
  senderName: string;
  senderEmail: string;
  senderCompany: string | null;
  message: string | null;
  expiresAt: Date;
}

function formatWhen(d: Date): string {
  return d.toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
}

function brandOf(ctx: RequestContext): string {
  return ctx.senderCompany || ctx.senderName;
}

const SECURITY_FOOTER = [
  "This link is personal to you. Do not forward this email; anyone with the link could open the document.",
  "You will be asked to confirm a one-time code sent to this email address before signing.",
];

export function invitationEmail(ctx: RequestContext, recipient: { name: string; role: string }, link: string, opts: { reminder?: boolean; customSubject?: string } = {}): EmailContent {
  const action = recipient.role === "APPROVER" ? "review and approve" : "review and sign";
  const subject = opts.reminder ? `Reminder: ${ctx.senderName} is waiting for you to ${action} "${ctx.title}"` : opts.customSubject || `Please ${action}: ${ctx.title}`;
  const { html, text } = layout({
    appUrl: ctx.appUrl,
    preheader: `${ctx.senderName} sent you "${ctx.documentTitle}" to ${action}.`,
    brand: brandOf(ctx),
    heading: opts.reminder ? `Reminder: "${ctx.title}" is waiting for you` : `${ctx.senderName} sent you a document to ${action}`,
    paragraphs: [
      `Hello ${recipient.name},`,
      opts.reminder
        ? `This is a reminder that "${ctx.documentTitle}" still needs your ${recipient.role === "APPROVER" ? "approval" : "signature"}.`
        : `${ctx.senderName} (${ctx.senderEmail}) has asked you to ${action} "${ctx.documentTitle}".`,
      "Open the document, read every page, then follow the steps to sign electronically. You can also decline if something is wrong.",
    ],
    quote: ctx.message ? { from: ctx.senderName, text: ctx.message } : null,
    details: [
      ["Document", ctx.documentTitle],
      ["Sent by", `${ctx.senderName} <${ctx.senderEmail}>`],
      ["Link expires", formatWhen(ctx.expiresAt)],
    ],
    button: { label: "Review Document", url: link },
    footer: [...SECURITY_FOOTER, `Questions about the document? Reply to ${ctx.senderEmail}.`],
  });
  return { subject, html, text };
}

export function otpEmail(ctx: RequestContext, recipient: { name: string }, code: string): EmailContent {
  const { html, text } = layout({
    appUrl: ctx.appUrl,
    preheader: `Your signing code is ${code}`,
    brand: brandOf(ctx),
    heading: "Your signing code",
    paragraphs: [`Hello ${recipient.name},`, `Use this code to confirm your identity before signing "${ctx.documentTitle}". It expires in 10 minutes.`],
    code,
    footer: ["If you did not try to sign this document, ignore this email. Never share this code with anyone."],
  });
  return { subject: `${code} is your code to sign "${ctx.title}"`, html, text };
}

export type SenderNotice = "VIEWED" | "PARTIALLY_SIGNED" | "REJECTED" | "EXPIRED" | "DELIVERY_FAILED";

export function senderNoticeEmail(ctx: RequestContext, kind: SenderNotice, info: { who?: string; reason?: string | null; detailsUrl: string; signed?: number; total?: number }): EmailContent {
  const copy: Record<SenderNotice, { subject: string; heading: string; body: string }> = {
    VIEWED: { subject: `${info.who} opened "${ctx.title}"`, heading: "Your document was opened", body: `${info.who} opened "${ctx.documentTitle}".` },
    PARTIALLY_SIGNED: {
      subject: `${info.who} signed "${ctx.title}"`,
      heading: "A recipient signed your document",
      body: `${info.who} signed "${ctx.documentTitle}". ${info.signed ?? 0} of ${info.total ?? 0} signatures are complete.`,
    },
    REJECTED: { subject: `${info.who} declined to sign "${ctx.title}"`, heading: "Your document was declined", body: `${info.who} declined "${ctx.documentTitle}". The request is closed and nobody else can sign it.` },
    EXPIRED: { subject: `"${ctx.title}" expired before everyone signed`, heading: "Your signing request expired", body: `"${ctx.documentTitle}" passed its expiry date before all signatures were collected.` },
    DELIVERY_FAILED: {
      subject: `Could not email ${info.who} for "${ctx.title}"`,
      heading: "A signing email could not be sent",
      body: `The email to ${info.who} for "${ctx.documentTitle}" was not accepted by your email provider. Check the address and resend from the request page.`,
    },
  };
  const c = copy[kind];
  const { html, text } = layout({
    appUrl: ctx.appUrl,
    preheader: c.heading,
    brand: brandOf(ctx),
    heading: c.heading,
    paragraphs: [c.body],
    details: info.reason ? [["Reason", info.reason]] : undefined,
    button: { label: "Open request", url: info.detailsUrl },
    footer: ["You receive these updates because you sent this signing request."],
  });
  return { subject: c.subject, html, text };
}

export function completedEmail(ctx: RequestContext, recipient: { name: string }, info: { finalSha256: string; completedAt: Date; signatureLevel: string }): EmailContent {
  const { html, text } = layout({
    appUrl: ctx.appUrl,
    preheader: `Everyone has signed "${ctx.documentTitle}".`,
    brand: brandOf(ctx),
    heading: `"${ctx.title}" is complete`,
    paragraphs: [`Hello ${recipient.name},`, `All parties have signed "${ctx.documentTitle}". The signed PDF and the completion certificate are attached to this email.`],
    details: [
      ["Completed", formatWhen(info.completedAt)],
      ["Signature type", info.signatureLevel],
      ["SHA-256 of signed PDF", info.finalSha256],
    ],
    footer: ["Keep this email for your records. The SHA-256 value lets anyone check that the attached PDF has not been changed."],
  });
  return { subject: `Completed: ${ctx.title}`, html, text };
}

export function cancelledEmail(ctx: RequestContext, recipient: { name: string }, reason: string | null): EmailContent {
  const { html, text } = layout({
    appUrl: ctx.appUrl,
    preheader: `${ctx.senderName} cancelled "${ctx.title}".`,
    brand: brandOf(ctx),
    heading: "This signing request was cancelled",
    paragraphs: [`Hello ${recipient.name},`, `${ctx.senderName} cancelled the request to sign "${ctx.documentTitle}". The signing link no longer works and no action is needed.`],
    details: reason ? [["Reason", reason]] : undefined,
    footer: [`Questions? Contact ${ctx.senderEmail}.`],
  });
  return { subject: `Cancelled: ${ctx.title}`, html, text };
}

export function rejectedNoticeEmail(ctx: RequestContext, recipient: { name: string }, who: string): EmailContent {
  const { html, text } = layout({
    appUrl: ctx.appUrl,
    preheader: `"${ctx.title}" was declined.`,
    brand: brandOf(ctx),
    heading: "This signing request was closed",
    paragraphs: [`Hello ${recipient.name},`, `${who} declined to sign "${ctx.documentTitle}", so the request is closed. Your link no longer works and no action is needed.`],
    footer: [`Questions? Contact ${ctx.senderEmail}.`],
  });
  return { subject: `Closed: ${ctx.title}`, html, text };
}
