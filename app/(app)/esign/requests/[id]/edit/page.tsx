import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { RequestWizard } from "@/components/esign/request-wizard";
import { PageHeader } from "@/components/ui/misc";
import { requireUser } from "@/lib/auth/session";
import { getOwnedRequest, readinessProblems } from "@/lib/esign/requests";
import { wizardContext } from "@/lib/esign/wizard-data";

export const metadata: Metadata = { title: "Edit signing request" };

export default async function EditSigningRequestPage({ params, searchParams }: PageProps<"/esign/requests/[id]/edit">) {
  const user = await requireUser();
  const { id } = await params;
  const { step } = await searchParams;
  const req = await getOwnedRequest(user.id, id).catch(() => null);
  if (!req) notFound();
  if (req.status !== "DRAFT") redirect(`/esign/requests/${id}`);
  const ctx = await wizardContext(user.id);
  return (
    <>
      <PageHeader eyebrow="E-Signature · Draft" title={req.title} description="Finish the draft and send it for signature." />
      <RequestWizard
        documents={ctx.documents}
        sender={ctx.sender}
        emailAccount={ctx.emailAccount}
        smsAvailable={ctx.smsAvailable}
        initialStep={Number(typeof step === "string" ? step : 3) || 0}
        initialProblems={readinessProblems(req)}
        draft={{
          id: req.id,
          documentVersionId: req.documentVersionId,
          title: req.title,
          subject: req.subject,
          message: req.message,
          signingOrder: req.signingOrder,
          expiresAt: req.expiresAt.toISOString(),
          reminderEveryDays: req.reminderEveryDays,
          senderCompany: req.senderCompany,
          recipients: req.recipients.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, routingOrder: r.routingOrder, phone: r.phone, requireSmsOtp: r.requireSmsOtp })),
          fields: req.fields.map((f) => ({ id: f.id, recipientId: f.recipientId, type: f.type, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, required: f.required, label: f.label })),
        }}
      />
    </>
  );
}
