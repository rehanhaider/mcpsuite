import { describe, expect, it } from "vitest";
import { safeLoginRedirect } from "../src/lib/login-redirect.ts";

describe("safeLoginRedirect", () => {
  it("keeps app paths and their query strings", () => {
    expect(safeLoginRedirect("/app")).toBe("/app");
    expect(safeLoginRedirect("/app/approvals?action=123&status=pending")).toBe(
      "/app/approvals?action=123&status=pending",
    );
  });

  it.each([
    "//evil.test/app",
    "https://evil.test/app",
    "/login",
    "/application",
    "/app\\evil.test",
    "/app/\\evil.test",
    "/app\n/approvals",
    undefined,
  ])("rejects an unsafe return target: %s", (value) => {
    expect(safeLoginRedirect(value)).toBe("/app");
  });
});
