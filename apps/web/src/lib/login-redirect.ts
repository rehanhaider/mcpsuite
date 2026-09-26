/** Keep post-login navigation inside the authenticated app. */
export function safeLoginRedirect(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\/app(?:\/|[?#]|$)/.test(value) ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return "/app";
  }
  return value;
}
