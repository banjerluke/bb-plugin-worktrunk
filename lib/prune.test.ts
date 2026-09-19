import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adaptPruneOutput, parsePruneStdout } from "./prune";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8"),
  );
}

describe("adaptPruneOutput", () => {
  it("maps a recorded --dry-run payload", () => {
    const { entries, warnings } = adaptPruneOutput(fixture("prune-dry-run.json"));
    expect(warnings).toEqual([]);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      branch: "feat/gone",
      path: "/Users/example-user/worktrees/demo-app/feat-gone",
      kind: "worktree",
      reason: "ancestor of main",
      branchRemoved: true,
    });
  });

  it("keeps branch-only entries, which have no path", () => {
    const { entries } = adaptPruneOutput(fixture("prune-dry-run.json"));
    const branchOnly = entries.filter((entry) => entry.kind === "branch_only");
    expect(branchOnly.map((entry) => entry.path)).toEqual([null]);
  });

  // Applying reports `branch_outcome` where the dry run reported
  // `branch_deleted`, and drops reason/target entirely.
  it("maps the applied payload's different field names", () => {
    const { entries } = adaptPruneOutput(fixture("prune-apply.json"));
    expect(entries.map((entry) => entry.branchRemoved)).toEqual([true, true]);
    expect(entries[0]?.reason).toBe("");
  });

  it("reports an unrecognized kind rather than guessing", () => {
    const { entries } = adaptPruneOutput([{ branch: "b", kind: "tag" }]);
    expect(entries[0]?.kind).toBe("unknown");
  });

  it.each([
    ["null", null],
    ["an object", { removed: [] }],
    ["a string", "nothing to prune"],
  ])("warns instead of throwing for %s", (_label, input) => {
    const { entries, warnings } = adaptPruneOutput(input);
    expect(entries).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("returns nothing for an empty run", () => {
    expect(adaptPruneOutput([])).toEqual({ entries: [], warnings: [] });
  });

  it("keeps readable entries when a sibling is malformed", () => {
    const { entries, warnings } = adaptPruneOutput([
      { branch: "a", kind: "worktree", path: "/a" },
      42,
    ]);
    expect(entries).toHaveLength(1);
    expect(warnings.join(" ")).toContain("Skipped 1");
  });
});

describe("parsePruneStdout", () => {
  it("reads the JSON array", () => {
    const { entries } = parsePruneStdout('[{"branch":"a","kind":"worktree"}]');
    expect(entries).toHaveLength(1);
  });

  // `wt` writes "✓ Removed ..." progress lines to stderr, but a future version
  // interleaving them on stdout must not blank the confirmation.
  it("skips leading progress output", () => {
    const { entries } = parsePruneStdout(
      '◎ Removing a worktree...\n[{"branch":"a","kind":"worktree"}]',
    );
    expect(entries).toHaveLength(1);
  });

  it.each([
    ["no JSON at all", "nothing to prune"],
    ["truncated JSON", '[{"branch":'],
  ])("warns instead of throwing for %s", (_label, input) => {
    const { entries, warnings } = parsePruneStdout(input);
    expect(entries).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});
