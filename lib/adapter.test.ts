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
    expect(snapshot.worktrees).toHaveLength(4);
    expect(snapshot.warnings).toEqual([]);
  });

  it("derives ownership from the worktree path", () => {
    const { worktrees } = adaptListOutput(fixture, "/repo");
    const byOwnership = worktrees.map((worktree) => worktree.ownership);
    expect(byOwnership.filter((value) => value === "bb")).toHaveLength(2);
    expect(byOwnership.filter((value) => value === "user")).toHaveLength(2);
  });

  it("marks the main checkout", () => {
    const { worktrees } = adaptListOutput(fixture, "/repo");
    const main = worktrees.filter((worktree) => worktree.isMain);
    expect(main).toHaveLength(1);
    expect(main[0]?.ownership).toBe("user");
  });

  it("reads a prune candidate from the structured integration reason", () => {
    const { worktrees } = adaptListOutput(fixture, "/repo");
    const candidates = worktrees.filter((worktree) => worktree.pruneCandidate);
    expect(candidates.map((worktree) => worktree.branch)).toEqual([
      "feat/integrated",
    ]);
  });

  it.each([
    ["same_commit", true],
    ["ancestor", true],
    [undefined, false],
  ])("treats integration reason %s as prunable: %s", (reason, expected) => {
    const snapshot = adaptListOutput(
      {
        schema: 2,
        items: [
          {
            branch: "b",
            worktree: { path: "/w" },
            default_branch:
              reason === undefined ? {} : { integration: { reason } },
          },
        ],
      },
      "/repo",
    );
    expect(snapshot.worktrees[0]?.pruneCandidate).toBe(expected);
  });

  // A structured reason `wt` adds later must not be guessed at as prunable:
  // this feeds the only mutation the plugin performs.
  it("does not treat an unknown integration reason as prunable", () => {
    const snapshot = adaptListOutput(
      {
        schema: 2,
        items: [
          {
            branch: "b",
            worktree: { path: "/w" },
            default_branch: { integration: { reason: "something_new" } },
            display: { symbols: "⊂" },
          },
        ],
      },
      "/repo",
    );
    expect(snapshot.worktrees[0]?.pruneCandidate).toBe(false);
  });

  it("falls back to display symbols when integration is absent", () => {
    const snapshot = adaptListOutput(
      {
        schema: 2,
        items: [{ branch: "b", worktree: { path: "/w" }, display: { symbols: "_" } }],
      },
      "/repo",
    );
    expect(snapshot.worktrees[0]?.pruneCandidate).toBe(true);
  });

  it("seeds lastTouchedAt from the head commit date", () => {
    const { worktrees } = adaptListOutput(fixture, "/repo");
    const integrated = worktrees.find(
      (worktree) => worktree.branch === "feat/integrated",
    );
    expect(integrated?.lastTouchedAt).toBe("2026-08-02T09:14:31Z");
  });

  it("leaves lastTouchedAt null when there is no head", () => {
    const snapshot = adaptListOutput(
      { schema: 2, items: [{ branch: "b", worktree: { path: "/w" } }] },
      "/repo",
    );
    expect(snapshot.worktrees[0]?.lastTouchedAt).toBeNull();
  });

  it("reads dirtiness from any kind of change", () => {
    const { worktrees } = adaptListOutput(fixture, "/repo");
    const dirty = worktrees.filter((worktree) => worktree.dirty);
    expect(dirty.map((worktree) => worktree.branch)).toEqual([
      "feat/integrated",
    ]);
  });

  // The adapter must never throw: worktrunk ships on its own cadence, and an
  // unexpected payload has to degrade a row rather than blank the panel.
  it.each([
    ["null", null],
    ["a string", "nope"],
    ["an empty object", {}],
    ["items of the wrong type", { schema: 2, items: [1, "two", null] }],
    ["an item with no worktree", { schema: 2, items: [{ branch: "x" }] }],
    ["a null default_branch block", {
      schema: 2,
      items: [{ branch: "x", default_branch: null }],
    }],
    ["items that are not an array", { schema: 2, items: "lots" }],
  ])("survives %s", (_label, input) => {
    const snapshot = adaptListOutput(input, "/repo");
    expect(snapshot.worktrees).toEqual([]);
    expect(snapshot.repoPath).toBe("/repo");
  });

  it("keeps usable rows when a sibling row is malformed", () => {
    const good = (fixture as { items: unknown[] }).items[0];
    const snapshot = adaptListOutput({ schema: 2, items: [good, 42] }, "/repo");
    expect(snapshot.worktrees).toHaveLength(1);
    expect(snapshot.warnings.join(" ")).toContain("Skipped 1");
  });

  it("warns when the schema version is not the one it targets", () => {
    const snapshot = adaptListOutput({ schema: 99, items: [] }, "/repo");
    expect(snapshot.warnings.join(" ")).toContain("schema 99");
  });
});
