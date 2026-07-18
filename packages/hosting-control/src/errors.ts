/**
 * Typed service errors mapped straight onto the hosting-control HTTP error
 * envelope: { error: { code, message, retryable, ...extra }, requestId }.
 */
export class HcError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra?: Record<string, unknown>,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "HcError";
  }
}
