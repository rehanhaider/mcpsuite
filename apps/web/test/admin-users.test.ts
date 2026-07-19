/**
 * Source-contract checks for the Admin → Users page (docs/issues/0022):
 * setup/reset codes replaced admin-supplied passwords, deletion requires a
 * typed confirmation, and ownership transfer is an owner-only affordance.
 * Follows the ui-migration.test.tsx pattern of asserting on route source.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routePath = fileURLToPath(new URL("../src/routes/app.admin.users.tsx", import.meta.url));
const source = readFileSync(routePath, "utf8");

describe("admin users UI — identity lifecycle", () => {
  it("runs on setup/reset codes, never a generated password", () => {
    expect(source).toContain('useOp("user.create")');
    expect(source).toContain("user.regenerateSetupCode");
    expect(source).toContain("setupCode");
    expect(source).toContain("resetCode");
    expect(source).not.toContain("oneTimePassword");
  });

  it("shows a status badge driven by the user lifecycle status", () => {
    expect(source).toContain('pending: "warning"');
    expect(source).toContain("STATUS_TONE[u.status]");
  });

  it("offers the regenerate affordance only for pending users, display-once", () => {
    expect(source).toMatch(/u\.status === "pending" \?/);
    // The code modal renders from transient state and is never persisted.
    expect(source).toContain("setCodeInfo");
    expect(source).toContain("navigator.clipboard.writeText(info.code)");
  });

  it("guards permanent deletion behind a typed email confirmation", () => {
    expect(source).toContain('useOp("user.delete"');
    expect(source).toContain("confirmText.trim().toLowerCase() === user.email.toLowerCase()");
    expect(source).toContain('variant="destructive"');
  });

  it("offers transfer-ownership to the owner only, for active non-owner users", () => {
    expect(source).toContain('useOp("user.transferOwnership"');
    expect(source).toContain('isOwner && u.role !== "owner" && u.status === "active"');
  });
});
