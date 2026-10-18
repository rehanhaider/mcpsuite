import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runOperation, type Catalog } from "../src/catalog.ts";
import { systemContext } from "../src/context.ts";
import { defineOperation } from "../src/operations/define.ts";
import type { Ports } from "../src/ports.ts";
import { auditChanges, displayRef, listAccepts, LISTABLE_TYPES, validateCustomFieldValue, type CustomFieldDef } from "../src/domain.ts";
import { fieldChanges } from "../src/operations/helpers.ts";
import { canCancelPendingAction, canManageSavedView, roleAtLeast, trustAllows } from "../src/policy.ts";
import { OpError, toErrorPayload } from "../src/errors.ts";
import { newId, slugify } from "../src/ids.ts";

// Core typechecks without DOM or Node globals; the tests spy on this one.
declare const console: { error(message: string): void };

describe("fieldChanges", () => {
  it("omits an unchanged field", () => {
    expect(fieldChanges({ name: "a" }, { name: "a" }, ["name"])).toEqual({});
  });

  it("records a changed string and excludes fields outside the patch", () => {
    expect(fieldChanges({ name: "a", version: 1 }, { name: "b", version: 2 }, ["name"])).toEqual({
      name: { before: "a", after: "b" },
    });
  });

  it("compares arrays by content and preserves their order", () => {
    expect(fieldChanges({ options: ["a", "b"] }, { options: ["a", "b"] }, ["options"])).toEqual({});
    expect(fieldChanges({ options: ["a", "b"] }, { options: ["b", "a"] }, ["options"])).toEqual({
      options: { before: ["a", "b"], after: ["b", "a"] },
    });
  });

  it("ignores object key order recursively, including objects in arrays", () => {
    const before = { filters: { name: "a", nested: [{ x: 1, y: { a: 2, b: 3 } }] } };
    const after = { filters: { nested: [{ y: { b: 3, a: 2 }, x: 1 }], name: "a" } };
    expect(fieldChanges(before, after, ["filters"])).toEqual({});
    expect(fieldChanges(before, { filters: { name: "b" } }, ["filters"])).toEqual({
      filters: { before: before.filters, after: { name: "b" } },
    });
  });

  it("treats undefined and null as unchanged", () => {
    expect(fieldChanges({ name: undefined }, { name: null }, ["name"])).toEqual({});
    expect(fieldChanges({ name: null }, {}, ["name"])).toEqual({});
  });

  it("records a missing value as null", () => {
    expect(fieldChanges({}, { name: "x" }, ["name"])).toEqual({
      name: { before: null, after: "x" },
    });
  });
});

describe("auditChanges", () => {
  it("returns the recorded changes", () => {
    const changes = { name: { before: "a", after: "b" } };
    expect(auditChanges({ meta: { changes } })).toEqual(changes);
    expect(auditChanges({ meta: { changes: {} } })).toEqual({});
  });

  it("returns null for absent or malformed changes", () => {
    expect(auditChanges({ meta: null })).toBeNull();
    expect(auditChanges({ meta: { fields: ["name"] } })).toBeNull();
    expect(auditChanges({ meta: { changes: { name: "b" } } })).toBeNull();
    expect(auditChanges({ meta: { changes: { name: { before: "a", after: "b", extra: true } } } })).toBeNull();
  });
});

describe("policy", () => {
  it("role ladder", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "owner")).toBe(false);
    expect(roleAtLeast("member", "member")).toBe(true);
    expect(roleAtLeast("viewer", "member")).toBe(false);
  });

  it("cancel rule", () => {
    const action = { requestedByUserId: "user-1", requestedByClientId: "client-1" };
    expect(canCancelPendingAction({ role: "member", userId: "user-1", clientId: null }, action)).toBe(true);
    expect(canCancelPendingAction({ role: "member", userId: "user-2", clientId: null }, action)).toBe(false);
    expect(canCancelPendingAction({ role: "member", userId: "user-2", clientId: "client-1" }, action)).toBe(true);
    expect(canCancelPendingAction({ role: "admin", userId: "user-2", clientId: "client-2" }, action)).toBe(true);
    expect(canCancelPendingAction({ role: "owner", userId: "user-2", clientId: "client-2" }, action)).toBe(true);
    expect(canCancelPendingAction(
      { role: "member", userId: null, clientId: null },
      { requestedByUserId: null, requestedByClientId: null },
    )).toBe(false);
  });

  it("saved view manage rule", () => {
    const mine = { visibility: "private" as const, ownerUserId: "user-1" };
    const shared = { visibility: "shared" as const, ownerUserId: "user-2" };
    const system = { visibility: "system" as const, ownerUserId: null };
    expect(canManageSavedView({ role: "member", userId: "user-1" }, mine)).toBe(true);
    expect(canManageSavedView({ role: "member", userId: "user-2" }, mine)).toBe(false);
    expect(canManageSavedView({ role: "admin", userId: "user-2" }, mine)).toBe(true);
    expect(canManageSavedView({ role: "member", userId: "user-1" }, shared)).toBe(true);
    expect(canManageSavedView({ role: "viewer", userId: "user-2" }, shared)).toBe(false);
    expect(canManageSavedView({ role: "viewer", userId: "user-1" }, mine)).toBe(false);
    expect(canManageSavedView({ role: "owner", userId: "user-1" }, system)).toBe(false);
    expect(canManageSavedView({ role: "member", userId: null }, { visibility: "private", ownerUserId: null })).toBe(false);
  });

  it("trust matrix", () => {
    expect(trustAllows("review_risky_actions", "bulk")).toBe(false);
    expect(trustAllows("trusted_agent", "bulk")).toBe(true);
    expect(trustAllows("trusted_agent", "destructive")).toBe(false);
    expect(trustAllows("fully_authorized_agent", "destructive")).toBe(true);
  });
});

describe("ids", () => {
  it("uuidv7 ids are time-ordered", () => {
    const a = newId();
    const b = newId();
    expect(a < b).toBe(true);
  });

  it("slugify", () => {
    expect(slugify("Pitch Angle!")).toBe("pitch-angle");
    expect(slugify("  Why   Fit  ")).toBe("why-fit");
  });
});

describe("displayRef", () => {
  it("uses workspace prefixes with defaults", () => {
    expect(displayRef({ engagement: "LEAD" }, "engagement", 42)).toBe("LEAD-42");
    expect(displayRef({}, "deal", 7)).toBe("DEAL-7");
  });
});

describe("listAccepts", () => {
  it.each(LISTABLE_TYPES)("accepts %s in an untyped list", (type) => {
    expect(listAccepts({ entityType: null }, type)).toBe(true);
  });

  it.each(LISTABLE_TYPES)("restricts a %s list to its own kind", (entityType) => {
    for (const type of LISTABLE_TYPES) {
      expect(listAccepts({ entityType }, type)).toBe(type === entityType);
    }
  });
});

describe("validateCustomFieldValue", () => {
  const def = (type: CustomFieldDef["type"], options: string[] | null = null): CustomFieldDef => ({
    id: "f",
    entityType: "engagement",
    key: "k",
    label: "K",
    type,
    options,
    required: false,
    position: 0,
    archivedAt: null,
  });

  it("accepts valid values", () => {
    expect(validateCustomFieldValue(def("text"), "hi")).toBe("hi");
    expect(validateCustomFieldValue(def("number"), 3.5)).toBe(3.5);
    expect(validateCustomFieldValue(def("boolean"), true)).toBe(true);
    expect(validateCustomFieldValue(def("date"), "2026-01-31")).toBe("2026-01-31");
    expect(validateCustomFieldValue(def("select", ["a", "b"]), "a")).toBe("a");
    expect(validateCustomFieldValue(def("url"), "example.com/x")).toBe("example.com/x");
    expect(validateCustomFieldValue(def("email"), "a@b.co")).toBe("a@b.co");
    expect(validateCustomFieldValue(def("text"), null)).toBe(null);
  });

  it("rejects invalid values", () => {
    expect(() => validateCustomFieldValue(def("number"), "x")).toThrow();
    expect(() => validateCustomFieldValue(def("date"), "31/01/2026")).toThrow();
    expect(() => validateCustomFieldValue(def("select", ["a"]), "z")).toThrow();
    expect(() => validateCustomFieldValue(def("email"), "not-an-email")).toThrow();
  });
});

describe("errors", () => {
  it("maps OpError to payload", () => {
    const payload = toErrorPayload(OpError.notFound("company", "c1"));
    expect(payload.code).toBe("not_found");
    expect(payload.details).toEqual({ entity: "company", id: "c1" });
  });

  it("wraps unknown errors as internal", () => {
    expect(toErrorPayload(new Error("boom")).code).toBe("internal");
  });

  const ports = { tx: async (fn) => fn() } as Ports;
  const ctx = systemContext("test-workspace");
  const secret = "s3cr3t-value";

  function throwingCatalog(error: Error, duringParse = false): Catalog {
    const input = z.object({ secret: z.string() });
    const op = defineOperation({
      name: "test.fail",
      title: "Forced failure",
      description: "Exercise error responses",
      input: duringParse ? z.preprocess(() => { throw error; }, input) : input,
      minRole: "member",
      scope: "write",
      handler: async () => { throw error; },
    });
    return new Map([[op.name, op]]);
  }

  it.each([
    { error: new Error("boom"), duringParse: false },
    { error: new Error("boom"), duringParse: true },
    { error: new OpError("internal", "boom"), duringParse: false },
  ])("matches an internal error response to one log without input: $error.name, parse=$duringParse", async ({ error, duringParse }) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runOperation(throwingCatalog(error, duringParse), ports, ctx, "test.fail", { secret });
      expect(result.status).toBe("error");
      if (result.status !== "error") throw new Error("Expected an error result");
      expect(result.error.code).toBe("internal");
      expect(result.error.message).toBe(error instanceof OpError ? "boom" : "An internal error occurred");
      expect(result.error.reference).toMatch(/^[0-9a-f]{12}$/);
      expect(log).toHaveBeenCalledExactlyOnceWith(
        `[mcpsuite] error ref=${result.error.reference} context=op test.fail code=internal: ${error.name}: boom`,
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    } finally {
      log.mockRestore();
    }
  });

  it.each([false, true])("does not reference or log an OpError validation failure, parse=%s", async (duringParse) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runOperation(
        throwingCatalog(OpError.validation("Invalid value"), duringParse), ports, ctx, "test.fail", { secret },
      );
      expect(result).toEqual({ status: "error", error: { code: "validation", message: "Invalid value" } });
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
