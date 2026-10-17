import { OpError } from "../errors.ts";
import { actorStamp } from "../context.ts";
import type { OpCtx } from "./define.ts";
import type { AuditInput } from "../ports.ts";
import type { AuditChanges } from "../domain.ts";

export function found<T>(value: T | null | undefined, entity: string, id: string): T {
  if (value == null) throw OpError.notFound(entity, id);
  return value;
}

export function checkVersion(entity: string, id: string, current: number, expected?: number): void {
  if (expected !== undefined && expected !== current) {
    throw OpError.versionConflict(entity, id, current);
  }
}

export async function audit(op: OpCtx, input: AuditInput): Promise<void> {
  await op.ports.audit.record(input, actorStamp(op.ctx));
}

/** Strip undefined keys so partial patches don't overwrite with undefined. */
export function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

function stableJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const record = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
    }
    return v;
  });
}

/**
 * The `fields` whose value differs between `before` and `after`, as old/new
 * pairs for an update's audit event (issue #44). Arrays and objects compare by
 * content (object key order ignored). A missing value is recorded as null so the
 * pair survives JSON storage, and missing vs null counts as unchanged.
 */
export function fieldChanges(before: object, after: object, fields: Iterable<string>): AuditChanges {
  const changes: AuditChanges = {};
  for (const field of fields) {
    const b = (before as Record<string, unknown>)[field];
    const a = (after as Record<string, unknown>)[field];
    if (stableJson(b ?? null) === stableJson(a ?? null)) continue;
    changes[field] = { before: b ?? null, after: a ?? null };
  }
  return changes;
}
