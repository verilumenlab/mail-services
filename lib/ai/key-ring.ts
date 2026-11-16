/** Orders AI keys and decides when a failed key should be skipped. Pure: no I/O and no key values in logs. */

export function uniqueKeys(...groups: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const part of group.split(/[\s,]+/)) {
      const key = part.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/** Starts at `start` and wraps, so the key after a failure is tried next. */
export function rotate<T>(items: T[], start: number): T[] {
  if (!items.length) return [];
  const i = ((start % items.length) + items.length) % items.length;
  return [...items.slice(i), ...items.slice(0, i)];
}

/** A key that is out of credit, rate limited, rejected, or whose provider is down should yield to the next key. */
export function switchesKey(kind: string, message: string): boolean {
  if (kind === "CREDITS" || kind === "RATE_LIMIT" || kind === "AUTH" || kind === "SERVER") return true;
  return /credit|afford|quota|insufficient|billing/i.test(message);
}

export function cooldownMs(kind: string, retryAfterMs?: number): number {
  if (kind === "CREDITS") return 10 * 60_000;
  if (kind === "AUTH") return 30 * 60_000;
  if (kind === "RATE_LIMIT") return retryAfterMs ?? 20_000;
  return retryAfterMs ?? 15_000;
}
