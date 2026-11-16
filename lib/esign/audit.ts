import "server-only";
import { db, Prisma } from "@/lib/database/prisma";
import { auditHash, verifyAuditChain, type AuditEntry, type StoredAuditRow } from "./audit-chain";

type Tx = Prisma.TransactionClient;

export interface Actor {
  /** "sender:<email>", "signer:<email>" or "system". */
  actor: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditInput extends Actor {
  action: string;
  userId?: string | null;
  requestId?: string | null;
  documentId?: string | null;
  recipientId?: string | null;
  details?: Record<string, unknown> | null;
}

/** Appends one tamper-evident audit row. Rows of the same request (or user) form one hash chain. */
export async function appendAudit(tx: Tx, input: AuditInput): Promise<void> {
  const requestId = input.requestId ?? null;
  const userId = input.userId ?? null;
  const scope = requestId ? `req:${requestId}` : `user:${userId ?? "system"}`;
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${scope}))) AS l`;
  const prev = await tx.auditLog.findFirst({
    where: requestId ? { requestId } : { requestId: null, userId },
    orderBy: { seq: "desc" },
    select: { hash: true },
  });
  const createdAt = new Date();
  const entry: AuditEntry = {
    action: input.action,
    actor: input.actor,
    userId,
    requestId,
    documentId: input.documentId ?? null,
    recipientId: input.recipientId ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent?.slice(0, 300) ?? null,
    details: input.details ?? null,
    createdAt: createdAt.toISOString(),
  };
  const prevHash = prev?.hash ?? null;
  await tx.auditLog.create({
    data: {
      ...entry,
      details: entry.details === null ? Prisma.DbNull : (entry.details as Prisma.InputJsonObject),
      createdAt,
      prevHash,
      hash: auditHash(prevHash, entry),
    },
  });
}

export interface EventInput extends Actor {
  requestId: string;
  userId: string;
  recipientId?: string | null;
  type: string;
  message: string;
  metadata?: Record<string, unknown> | null;
}

/** Records a timeline event and its matching audit row in the same transaction. */
export async function recordEvent(tx: Tx, input: EventInput): Promise<void> {
  await tx.signatureEvent.create({
    data: {
      requestId: input.requestId,
      recipientId: input.recipientId ?? null,
      type: input.type,
      message: input.message,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      metadata: input.metadata ? (input.metadata as Prisma.InputJsonObject) : Prisma.DbNull,
    },
  });
  await appendAudit(tx, {
    action: input.type,
    actor: input.actor,
    ip: input.ip,
    userAgent: input.userAgent,
    userId: input.userId,
    requestId: input.requestId,
    recipientId: input.recipientId,
    details: { message: input.message, ...(input.metadata ?? {}) },
  });
}

/** Same as appendAudit, in its own transaction. */
export async function recordAuditNow(input: AuditInput): Promise<void> {
  await db().$transaction((tx) => appendAudit(tx, input));
}

/** Same as recordEvent, in its own transaction. */
export async function recordEventNow(input: EventInput): Promise<void> {
  await db().$transaction((tx) => recordEvent(tx, input));
}

export async function auditTrail(requestId: string) {
  const rows = await db().auditLog.findMany({ where: { requestId }, orderBy: { seq: "asc" } });
  const stored: StoredAuditRow[] = rows.map((r) => ({
    id: r.id,
    action: r.action,
    actor: r.actor,
    userId: r.userId,
    requestId: r.requestId,
    documentId: r.documentId,
    recipientId: r.recipientId,
    ip: r.ip,
    userAgent: r.userAgent,
    details: r.details ?? null,
    createdAt: r.createdAt.toISOString(),
    prevHash: r.prevHash,
    hash: r.hash,
  }));
  return { rows: stored, integrity: verifyAuditChain(stored) };
}
