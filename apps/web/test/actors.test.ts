import { describe, expect, it } from "vitest";
import { actorUserName } from "../src/lib/actors.ts";

describe("actorUserName", () => {
  it("returns the name of an existing workspace member", () => {
    expect(actorUserName("member", [{ id: "member", name: "Team member" }])).toBe("Team member");
  });

  it("labels a missing member only after the user list loads", () => {
    expect(actorUserName("deleted", undefined)).toBeNull();
    expect(actorUserName("deleted", [])).toBe("Deleted user");
    expect(actorUserName("deleted", [{ id: "member", name: "Team member" }])).toBe("Deleted user");
  });

  it("does not label an actor without a user id as deleted", () => {
    expect(actorUserName(null, undefined)).toBeNull();
    expect(actorUserName(null, [])).toBeNull();
  });
});
