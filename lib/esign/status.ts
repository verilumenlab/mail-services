export type RequestStatus =
  | "DRAFT"
  | "SENT"
  | "DELIVERED"
  | "VIEWED"
  | "IN_REVIEW"
  | "PARTIALLY_SIGNED"
  | "PENDING"
  | "COMPLETED"
  | "REJECTED"
  | "EXPIRED"
  | "CANCELLED";

export type SignerStatusValue = "WAITING" | "SENT" | "DELIVERED" | "VIEWED" | "IN_REVIEW" | "SIGNED" | "REJECTED" | "EXPIRED" | "CANCELLED";
export type Role = "SIGNER" | "APPROVER" | "CC";
export type Order = "SEQUENTIAL" | "PARALLEL";

export interface RoutedRecipient {
  id: string;
  role: Role;
  routingOrder: number;
  status: SignerStatusValue;
}

export const TERMINAL_REQUEST: RequestStatus[] = ["COMPLETED", "REJECTED", "EXPIRED", "CANCELLED"];
/** Statuses in which recipients may still open, review and sign. */
export const OPEN_REQUEST: RequestStatus[] = ["SENT", "DELIVERED", "VIEWED", "IN_REVIEW", "PARTIALLY_SIGNED"];

const SIGNER_RANK: Record<SignerStatusValue, number> = {
  WAITING: 0,
  SENT: 1,
  DELIVERED: 2,
  VIEWED: 3,
  IN_REVIEW: 4,
  SIGNED: 5,
  REJECTED: 6,
  EXPIRED: 6,
  CANCELLED: 6,
};

export function isTerminalRequest(status: RequestStatus): boolean {
  return TERMINAL_REQUEST.includes(status);
}

/** Signer progress only moves forward; a final state (signed, rejected, expired, cancelled) never changes. */
export function advanceSigner(current: SignerStatusValue, next: SignerStatusValue): SignerStatusValue {
  if (SIGNER_RANK[current] >= 5) return current;
  return SIGNER_RANK[next] > SIGNER_RANK[current] ? next : current;
}

export function signersOf<T extends RoutedRecipient>(recipients: T[]): T[] {
  return recipients.filter((r) => r.role !== "CC");
}

/**
 * Who may act now. Parallel: every signer who has not signed. Sequential: the unsigned signers with the
 * lowest routing order (several signers can share an order number and then sign in parallel).
 */
export function activeSigners<T extends RoutedRecipient>(order: Order, recipients: T[]): T[] {
  const pending = signersOf(recipients).filter((r) => r.status !== "SIGNED");
  if (pending.some((r) => r.status === "REJECTED" || r.status === "CANCELLED" || r.status === "EXPIRED")) return [];
  if (order === "PARALLEL" || pending.length === 0) return pending;
  const first = Math.min(...pending.map((r) => r.routingOrder));
  return pending.filter((r) => r.routingOrder === first);
}

export function isTurnOf(order: Order, recipients: RoutedRecipient[], recipientId: string): boolean {
  return activeSigners(order, recipients).some((r) => r.id === recipientId);
}

/** Request status from its recipients. Final statuses are kept; PENDING means everyone signed and the final PDF is due. */
export function deriveRequestStatus(current: RequestStatus, recipients: RoutedRecipient[]): RequestStatus {
  if (isTerminalRequest(current) || current === "DRAFT") return current;
  const signers = signersOf(recipients);
  if (signers.some((r) => r.status === "REJECTED")) return "REJECTED";
  const signed = signers.filter((r) => r.status === "SIGNED").length;
  if (signers.length > 0 && signed === signers.length) return "PENDING";
  if (signed > 0) return "PARTIALLY_SIGNED";
  const best = Math.max(0, ...signers.map((r) => SIGNER_RANK[r.status]));
  if (best >= SIGNER_RANK.IN_REVIEW) return "IN_REVIEW";
  if (best >= SIGNER_RANK.VIEWED) return "VIEWED";
  if (best >= SIGNER_RANK.DELIVERED) return "DELIVERED";
  return "SENT";
}

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  DRAFT: "Draft",
  SENT: "Sent",
  DELIVERED: "Delivered",
  VIEWED: "Viewed",
  IN_REVIEW: "In review",
  PARTIALLY_SIGNED: "Partially signed",
  PENDING: "Finalising",
  COMPLETED: "Completed",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
};
