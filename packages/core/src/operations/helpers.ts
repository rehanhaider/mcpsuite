import { OpError } from "../errors.ts";
import { actorStamp } from "../context.ts";
import type { OpCtx } from "./define.ts";
import type { AuditInput } from "../ports.ts";

export function found<T>(value: T | null | undefined, entity: string, id: string): T {
  if (value == null) throw OpError.notFound(entity, id);
  return value;
}

export function checkVersion(entity: string, id: string, current: number, expected?: number): void {
  if (expected !== undefined && expected !== current) {
    throw OpError.versionConflict(entity, id, current);
  }
}

export function audit(op: OpCtx, input: AuditInput): void {
  op.ports.audit.record(input, actorStamp(op.ctx));
}

/** Strip undefined keys so partial patches don't overwrite with undefined. */
export function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
