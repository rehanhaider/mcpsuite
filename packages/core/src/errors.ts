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

  static inUse(entity: string, id: string, count: number): OpError {
    return new OpError("in_use", `${entity} ${id} is referenced by ${count} record(s); reassign them first.`, {
      entity,
      id,
      count,
    });
  }
}

export interface ErrorPayload {
  code: OpErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export function toErrorPayload(e: unknown): ErrorPayload {
  if (e instanceof OpError) {
    return { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { code: "internal", message };
}
