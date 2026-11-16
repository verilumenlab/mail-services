import type { Metadata } from "next";
import Link from "next/link";
import { FileText, Plus } from "lucide-react";
import { DocumentUpload } from "@/components/esign/document-upload";
import { RequestStatusBadge, formatBytes } from "@/components/esign/request-status";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader, KpiCard } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/database/prisma";
import { listDocuments } from "@/lib/esign/documents";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "E-Signature" };

const AWAITING = ["SENT", "DELIVERED", "VIEWED", "IN_REVIEW", "PARTIALLY_SIGNED", "PENDING"] as const;

export default async function EsignPage() {
  const user = await requireUser();
  const [documents, requests, counts] = await Promise.all([
    listDocuments(user.id),
    db().signatureRequest.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: {
        id: true,
        title: true,
        status: true,
        updatedAt: true,
        expiresAt: true,
        recipients: { select: { role: true, status: true } },
        version: { select: { version: true, document: { select: { title: true } } } },
      },
    }),
    db().signatureRequest.groupBy({ by: ["status"], where: { userId: user.id }, _count: { _all: true } }),
  ]);
  const count = (statuses: readonly string[]) => counts.filter((c) => statuses.includes(c.status)).reduce((n, c) => n + c._count._all, 0);

  return (
    <>
      <PageHeader
        eyebrow="E-Signature"
        title="Documents & signing requests"
        description="Upload a PDF or Word document, place signature fields, and send it for review and signature."
        actions={
          <>
            <DocumentUpload variant="secondary" />
            <ButtonLink href="/esign/requests/new" variant="primary" size="sm">
              <Plus aria-hidden />
              New signing request
            </ButtonLink>
          </>
        }
      />
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard label="Awaiting signature" value={count(AWAITING)} hint="Sent and not yet complete" />
          <KpiCard label="Completed" value={count(["COMPLETED"])} tone={count(["COMPLETED"]) ? "success" : "default"} hint="Signed by everyone" />
          <KpiCard label="Declined or expired" value={count(["REJECTED", "EXPIRED"])} tone={count(["REJECTED", "EXPIRED"]) ? "warning" : "default"} hint="Need a follow-up" />
          <KpiCard label="Documents" value={documents.length} hint={`${count(["DRAFT"])} draft request${count(["DRAFT"]) === 1 ? "" : "s"}`} />
        </div>

        <Card>
          <CardHeader title="Signing requests" description="Every request, newest activity first." />
          <CardBody className="p-0">
            {!requests.length ? (
              <div className="p-5">
                <EmptyState
                  compact
                  title="No signing requests yet"
                  description="Upload a document, then create a signing request to collect signatures."
                  action={
                    <ButtonLink href="/esign/requests/new" variant="primary" size="sm">
                      New signing request
                    </ButtonLink>
                  }
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-line bg-panel-2 text-xs text-muted">
                    <tr>
                      <th className="px-4 py-3 font-medium">Request</th>
                      <th className="px-4 py-3 font-medium">Document</th>
                      <th className="px-4 py-3 font-medium">Signed</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium">Updated</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {requests.map((r) => {
                      const signers = r.recipients.filter((x) => x.role !== "CC");
                      const signed = signers.filter((x) => x.status === "SIGNED").length;
                      return (
                        <tr key={r.id} className="transition-colors hover:bg-panel-2/50">
                          <td className="px-4 py-3">
                            <Link href={`/esign/requests/${r.id}`} className="font-medium text-fg hover:text-accent-strong hover:underline">
                              {r.title}
                            </Link>
                          </td>
                          <td className="px-4 py-3 text-muted">
                            {r.version.document.title} <span className="text-subtle">v{r.version.version}</span>
                          </td>
                          <td className="type-data px-4 py-3 text-muted">
                            {signed}/{signers.length}
                          </td>
                          <td className="px-4 py-3">
                            <RequestStatusBadge status={r.status} />
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-muted">{formatDateTime(r.updatedAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Documents" description="Stored encrypted. Each upload keeps its SHA-256 hash so later changes can be detected." />
          <CardBody className="p-0">
            {!documents.length ? (
              <div className="p-5">
                <EmptyState compact icon={<FileText className="h-5 w-5" strokeWidth={1.75} aria-hidden />} title="No documents yet" description="Upload a PDF or Word document to get started." action={<DocumentUpload />} />
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {documents.map((d) => {
                  const v = d.versions[0];
                  return (
                    <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                      <div className="min-w-0">
                        <Link href={`/esign/documents/${d.id}`} className="font-medium text-fg hover:text-accent-strong hover:underline">
                          {d.title}
                        </Link>
                        {v && (
                          <p className="type-caption mt-0.5 text-muted">
                            v{v.version} · {v.pageCount} page{v.pageCount === 1 ? "" : "s"} · {formatBytes(v.pdfSize)}
                            {v.converted ? " · converted from Word" : ""}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="type-caption text-subtle">{formatDateTime(d.updatedAt)}</span>
                        {v && (
                          <ButtonLink href={`/esign/requests/new?version=${v.id}`} variant="outline" size="sm">
                            Send for signature
                          </ButtonLink>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
