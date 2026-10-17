import { describe, expect, it } from "vitest";
import { nextSorting } from "../src/lib/sorting.ts";

describe("nextSorting", () => {
  it("starts a new column ascending", () => {
    expect(nextSorting([], "title")).toEqual([{ id: "title", desc: false }]);
  });

  it("flips the same column from ascending to descending", () => {
    expect(nextSorting([{ id: "title", desc: false }], "title")).toEqual([
      { id: "title", desc: true },
    ]);
  });

  it("flips the same column from descending to ascending", () => {
    expect(nextSorting([{ id: "title", desc: true }], "title")).toEqual([
      { id: "title", desc: false },
    ]);
  });

  it("resets to ascending when switching columns", () => {
    expect(nextSorting([{ id: "title", desc: true }], "displayId")).toEqual([
      { id: "displayId", desc: false },
    ]);
  });
});
