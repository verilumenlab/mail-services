import { Badge, type BadgeTone } from "@/components/ui/badge";
import { REQUEST_STATUS_LABEL, type RequestStatus } from "@/lib/esign/status";

const REQUEST_TONE: Record<RequestStatus, BadgeTone> = {
  DRAFT: "neutral",
  SENT: "accent",
  DELIVERED: "accent",
  VIEWED: "info",
  IN_REVIEW: "info",
  PARTIALLY_SIGNED: "violet",
  PENDING: "violet",
  COMPLETED: "success",
  REJECTED: "danger",
  EXPIRED: "warning",
  CANCELLED: "neutral",
};

export function RequestStatusBadge({ status }: { status: string }) {
  const s = status as RequestStatus;
  return (
    <Badge tone={REQUEST_TONE[s] ?? "neutral"} dot live={s === "PENDING"}>
      {REQUEST_STATUS_LABEL[s] ?? status}
    </Badge>
  );
}

const SIGNER_TONE: Record<string, BadgeTone> = {
  WAITING: "neutral",
  SENT: "accent",
  DELIVERED: "accent",
  VIEWED: "info",
  IN_REVIEW: "info",
  SIGNED: "success",
  REJECTED: "danger",
  EXPIRED: "warning",
  CANCELLED: "neutral",
};

const SIGNER_LABEL: Record<string, string> = {
  WAITING: "Waiting for turn",
  SENT: "Sent",
  DELIVERED: "Delivered",
  VIEWED: "Viewed",
  IN_REVIEW: "Reviewing",
  SIGNED: "Signed",
  REJECTED: "Declined",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
};

export function SignerStatusBadge({ status, role }: { status: string; role?: string }) {
  const label = role === "CC" && status === "SIGNED" ? "Copied" : role === "APPROVER" && status === "SIGNED" ? "Approved" : SIGNER_LABEL[status] ?? status;
  return (
    <Badge tone={SIGNER_TONE[status] ?? "neutral"} dot>
      {label}
    </Badge>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function shortHash(hash: string | null | undefined): string {
  return hash ? `${hash.slice(0, 12)}…${hash.slice(-6)}` : "—";
}
