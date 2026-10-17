/**
 * Structured operation errors. Stable codes so both humans and agents can
 * recover programmatically (per product spec "Operation Results And Errors").
 */
export type OpErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation"
  | "conflict"
  | "version_conflict"
  | "in_use"
  | "invalid_state"
  /** Hosted deployments: the workspace's generic access state is locked. */
  | "workspace_locked"
  /**
   * The caller's account has `password_must_change` set: authentication
   * succeeded but every operation except changing the password, logout and
   * whoami is refused until the user sets their own password
   * (docs/issues/0022 addendum).
   */
  | "password_change_required"
  | "internal";

export class OpError extends Error {
  constructor(
    public readonly code: OpErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OpError";
  }

  static notFound(entity: string, id: string): OpError {
    return new OpError("not_found", `${entity} ${id} not found`, { entity, id });
  }

  static forbidden(message = "You do not have permission to do this"): OpError {
    return new OpError("forbidden", message);
  }

  static validation(message: string, details?: Record<string, unknown>): OpError {
    return new OpError("validation", message, details);
  }

  static versionConflict(entity: string, id: string, currentVersion: number): OpError {
    return new OpError(
      "version_conflict",
      `${entity} ${id} was modified by someone else (current version ${currentVersion}). Re-read and retry.`,
      { entity, id, currentVersion },
    );
  }

  static inUse(entity: string, id: string, count: number, name?: string): OpError {
    return new OpError("in_use", `${entity} ${name !== undefined ? `"${name}"` : id} is referenced by ${count} record(s); reassign them first.`, {
      entity,
      id,
      count,
      ...(name !== undefined ? { name } : {}),
    });
  }
}

export interface ErrorPayload {
  code: OpErrorCode;
  message: string;
  details?: Record<string, unknown>;
  reference?: string;
}

export function toErrorPayload(e: unknown): ErrorPayload {
  if (e instanceof OpError) {
    return { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) };
  }
  return { code: "internal", message: "An internal error occurred" };
}

// Core compiles against plain ES2023 with no DOM or Node types; these are the
// only two runtime globals it uses (both exist in Node 22 and browsers).
declare const crypto: { randomUUID(): string };
declare const console: { error(message: string): void };

/** A short id shown to the user and written to the server log line. */
export function errorReference(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

/**
 * Internal failure: log one line an operator can find by reference, then
 * return the payload with that reference. Logs the error only, never the
 * operation input, request body, or credentials.
 */
export function internalErrorPayload(e: unknown, context: string): ErrorPayload {
  const payload = toErrorPayload(e);
  const reference = errorReference();
  const name = e instanceof Error ? e.name : "Error";
  console.error(`[mcpsuite] error ref=${reference} context=${context} code=internal: ${name}: ${payload.message}`);
  return { ...payload, reference };
}
