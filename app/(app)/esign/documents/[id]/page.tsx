import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download, Send } from "lucide-react";
import { DocumentPreview } from "@/components/esign/document-preview";
import { DocumentUpload } from "@/components/esign/document-upload";
import { RequestStatusBadge, formatBytes, shortHash } from "@/components/esign/request-status";
import { Badge } from "@/components/ui/badge";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/misc";
import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/database/prisma";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Document · E-Signature" };

export default async function DocumentPage({ params }: PageProps<"/esign/documents/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  const doc = await db().document.findFirst({ where: { id, userId: user.id }, include: { versions: { orderBy: { version: "desc" } } } });
  if (!doc) notFound();
  const latest = doc.versions[0];
  const requests = await db().signatureRequest.findMany({
    where: { userId: user.id, version: { documentId: doc.id } },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, status: true, createdAt: true, version: { select: { version: true } } },
  });

  return (
    <>
      <PageHeader
        eyebrow="E-Signature · Document"
        title={doc.title}
        description={latest ? `Version ${latest.version} · ${latest.pageCount} page${latest.pageCount === 1 ? "" : "s"} · ${formatBytes(latest.pdfSize)}` : undefined}
        actions={
          <>
            <DocumentUpload documentId={doc.id} variant="secondary" />
            {latest && (
              <ButtonLink href={`/esign/requests/new?version=${latest.id}`} variant="primary" size="sm">
                <Send aria-hidden />
                Send for signature
              </ButtonLink>
            )}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <CardBody>{latest ? <DocumentPreview src={`/api/documents/${doc.id}/file?version=${latest.id}`} /> : <p className="text-sm text-muted">No file uploaded.</p>}</CardBody>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Versions" description="Each version keeps its own file and SHA-256 hash." />
            <CardBody className="p-0">
              <ul className="divide-y divide-line">
                {doc.versions.map((v) => (
                  <li key={v.id} className="space-y-1.5 px-5 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-fg">
                        Version {v.version} {v.id === latest?.id && <Badge tone="accent">Latest</Badge>}
                      </span>
                      <span className="type-caption text-subtle">{formatDateTime(v.createdAt)}</span>
                    </div>
                    <p className="type-caption truncate text-muted" title={v.originalName}>
                      {v.originalName}
                      {v.converted ? " · converted to PDF" : ""}
                    </p>
                    <p className="type-data break-all text-[11px] text-subtle" title={v.originalSha256}>
                      SHA-256 {shortHash(v.originalSha256)}
                    </p>
                    <div className="flex flex-wrap gap-2 pt-1">
                      <a href={`/api/documents/${doc.id}/file?version=${v.id}&download=1`} className={buttonClasses({ variant: "outline", size: "xs" })}>
                        <Download aria-hidden />
                        PDF
                      </a>
                      {v.converted && (
                        <a href={`/api/documents/${doc.id}/file?version=${v.id}&download=1&original=1`} className={buttonClasses({ variant: "ghost", size: "xs" })}>
                          Original .docx
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Signing requests" />
            <CardBody className="p-0">
              {!requests.length ? (
                <p className="type-caption px-5 py-4 text-muted">This document has not been sent for signature yet.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {requests.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2 px-5 py-3">
                      <Link href={`/esign/requests/${r.id}`} className="min-w-0 truncate text-sm font-medium text-fg hover:text-accent-strong hover:underline">
                        {r.title} <span className="text-subtle">v{r.version.version}</span>
                      </Link>
                      <RequestStatusBadge status={r.status} />
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
