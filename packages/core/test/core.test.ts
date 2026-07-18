import { describe, expect, it } from "vitest";
import { displayRef, validateCustomFieldValue, type CustomFieldDef } from "../src/domain.ts";
import { roleAtLeast, trustAllows } from "../src/policy.ts";
import { OpError, toErrorPayload } from "../src/errors.ts";
import { newId, slugify } from "../src/ids.ts";

describe("policy", () => {
  it("role ladder", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "owner")).toBe(false);
    expect(roleAtLeast("member", "member")).toBe(true);
    expect(roleAtLeast("viewer", "member")).toBe(false);
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
});
