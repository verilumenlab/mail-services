import type { Metadata } from "next";
import { RequestWizard } from "@/components/esign/request-wizard";
import { PageHeader } from "@/components/ui/misc";
import { requireUser } from "@/lib/auth/session";
import { wizardContext } from "@/lib/esign/wizard-data";

export const metadata: Metadata = { title: "New signing request" };

export default async function NewSigningRequestPage({ searchParams }: PageProps<"/esign/requests/new">) {
  const user = await requireUser();
  const { version } = await searchParams;
  const ctx = await wizardContext(user.id);
  const initialVersionId = typeof version === "string" && ctx.documents.some((d) => d.versions.some((v) => v.id === version)) ? version : undefined;
  return (
    <>
      <PageHeader eyebrow="E-Signature" title="New signing request" description="Choose a document, add recipients, place fields and send it for signature." />
      <RequestWizard
        documents={ctx.documents}
        initialVersionId={initialVersionId}
        sender={ctx.sender}
        emailAccount={ctx.emailAccount}
        smsAvailable={ctx.smsAvailable}
      />
    </>
  );
}
