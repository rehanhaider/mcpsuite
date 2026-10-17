import { describe, expect, it } from "vitest";
import { actorUserName } from "../src/lib/actors.ts";

describe("actorUserName", () => {
  describe.each(["human", "agent"] as const)("%s actors", (actorType) => {
    it("returns the name of an existing workspace member", () => {
      expect(actorUserName(actorType, "member", [{ id: "member", name: "Team member" }])).toBe("Team member");
    });

    it("labels a missing member only after the user list loads", () => {
      expect(actorUserName(actorType, "deleted", undefined)).toBeNull();
      expect(actorUserName(actorType, "deleted", [])).toBe("Deleted user");
      expect(actorUserName(actorType, "deleted", [{ id: "member", name: "Team member" }])).toBe("Deleted user");
    });

    it("labels a null user id only after the user list loads", () => {
      expect(actorUserName(actorType, null, undefined)).toBeNull();
      expect(actorUserName(actorType, null, [])).toBe("Deleted user");
      expect(actorUserName(actorType, null, [{ id: "member", name: "Team member" }])).toBe("Deleted user");
    });
  });

  it("does not label a system actor without a user id as deleted", () => {
    expect(actorUserName("system", null, undefined)).toBeNull();
    expect(actorUserName("system", null, [])).toBeNull();
  });
});
