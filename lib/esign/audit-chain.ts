import { createHash } from "node:crypto";

export interface AuditEntry {
  action: string;
  actor: string;
  userId: string | null;
  requestId: string | null;
  documentId: string | null;
  recipientId: string | null;
  ip: string | null;
  userAgent: string | null;
  details: unknown;
  createdAt: string;
}

/** JSON with object keys sorted at every level, so the same entry always hashes the same way. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function auditHash(prevHash: string | null, entry: AuditEntry): string {
  return createHash("sha256").update(`${prevHash ?? "genesis"}\n${canonicalJson(entry)}`).digest("hex");
}

export interface StoredAuditRow extends AuditEntry {
  id: string;
  prevHash: string | null;
  hash: string;
}

/** Recomputes the chain in order. Returns the first row whose link or content does not match. */
export function verifyAuditChain(rows: StoredAuditRow[]): { ok: true } | { ok: false; brokenAt: string; reason: string } {
  let prev: string | null = null;
  for (const row of rows) {
    if (row.prevHash !== prev) return { ok: false, brokenAt: row.id, reason: "The link to the previous entry does not match." };
    const entry: AuditEntry = {
      action: row.action,
      actor: row.actor,
      userId: row.userId,
      requestId: row.requestId,
      documentId: row.documentId,
      recipientId: row.recipientId,
      ip: row.ip,
      userAgent: row.userAgent,
      details: row.details,
      createdAt: row.createdAt,
    };
    if (auditHash(prev, entry) !== row.hash) return { ok: false, brokenAt: row.id, reason: "The entry content does not match its hash." };
    prev = row.hash;
  }
  return { ok: true };
}
