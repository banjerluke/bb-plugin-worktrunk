import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adaptListOutput } from "./adapter";

const fixture: unknown = JSON.parse(
  readFileSync(new URL("../test/fixtures/list.json", import.meta.url), "utf8"),
);

describe("adaptListOutput", () => {
  it("maps a real wt list payload", () => {
    const snapshot = adaptListOutput(fixture, "/repo");
    expect(snapshot.defaultBranch).toBe("main");
    expect(snapshot.worktrees).toHaveLength(3);
    expect(snapshot.warnings).toEqual([]);
  });

  it("derives ownership from the worktree path", () => {
    const { worktrees } = adaptListOutput(fixture, "/repo");
    const byOwnership = worktrees.map((worktree) => worktree.ownership);
    expect(byOwnership.filter((value) => value === "bb")).toHaveLength(2);
    expect(byOwnership.filter((value) => value === "user")).toHaveLength(1);
  });

  it("marks the main checkout", () => {
    const { worktrees } = adaptListOutput(fixture, "/repo");
    const main = worktrees.filter((worktree) => worktree.isMain);
    expect(main).toHaveLength(1);
    expect(main[0]?.ownership).toBe("user");
  });

  // The adapter must never throw: worktrunk ships on its own cadence, and an
  // unexpected payload has to degrade a row rather than blank the panel.
  it.each([
    ["null", null],
    ["a string", "nope"],
    ["an empty object", {}],
    ["items of the wrong type", { schema: 2, items: [1, "two", null] }],
    ["an item with no worktree", { schema: 2, items: [{ branch: "x" }] }],
  ])("survives %s", (_label, input) => {
    const snapshot = adaptListOutput(input, "/repo");
    expect(snapshot.worktrees).toEqual([]);
    expect(snapshot.repoPath).toBe("/repo");
  });

  it("keeps usable rows when a sibling row is malformed", () => {
    const good = (fixture as { items: unknown[] }).items[0];
    const snapshot = adaptListOutput(
      { schema: 2, items: [good, 42] },
      "/repo",
    );
    expect(snapshot.worktrees).toHaveLength(1);
    expect(snapshot.warnings.join(" ")).toContain("Skipped 1");
  });

  it("warns when the schema version is not the one it targets", () => {
    const snapshot = adaptListOutput({ schema: 99, items: [] }, "/repo");
    expect(snapshot.warnings.join(" ")).toContain("schema 99");
  });
});
