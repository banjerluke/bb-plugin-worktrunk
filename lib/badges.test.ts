import { describe, expect, it } from "vitest";
import { AT_RISK_DAYS, badgesFor, needsAttention } from "./badges";

const NOW = Date.parse("2026-09-18T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

function row(overrides: Partial<Parameters<typeof badgesFor>[0]> = {}) {
  return {
    dirty: false,
    pruneCandidate: false,
    isMain: false,
    lastTouchedAt: daysAgo(1),
    bbAvailability: null,
    ...overrides,
  };
}

describe("badgesFor", () => {
  it("badges an integrated worktree as removable", () => {
    expect(badgesFor(row({ pruneCandidate: true }), NOW)).toEqual(["removable"]);
  });

  it("never offers to remove the main checkout", () => {
    expect(badgesFor(row({ pruneCandidate: true, isMain: true }), NOW)).toEqual(
      [],
    );
  });

  it("badges a dirty worktree untouched past the threshold", () => {
    const worktree = row({ dirty: true, lastTouchedAt: daysAgo(AT_RISK_DAYS) });
    expect(badgesFor(worktree, NOW)).toEqual(["at risk"]);
  });

  it("leaves a dirty worktree edited yesterday alone", () => {
    const worktree = row({ dirty: true, lastTouchedAt: daysAgo(1) });
    expect(badgesFor(worktree, NOW)).toEqual([]);
  });

  // The case the whole mtime pass exists for: an old commit is not evidence of
  // abandonment when the files were edited yesterday.
  it("leaves a stale commit alone when the files are fresh", () => {
    const worktree = row({ dirty: true, lastTouchedAt: daysAgo(0) });
    expect(badgesFor(worktree, NOW)).toEqual([]);
  });

  it("does not badge a clean worktree that has sat for months", () => {
    const worktree = row({ dirty: false, lastTouchedAt: daysAgo(120) });
    expect(badgesFor(worktree, NOW)).toEqual([]);
  });

  it("says nothing about staleness when the mtime pass failed", () => {
    const worktree = row({ dirty: true, lastTouchedAt: null });
    expect(badgesFor(worktree, NOW)).toEqual([]);
  });

  it("ignores an unparseable timestamp rather than aging it infinitely", () => {
    const worktree = row({ dirty: true, lastTouchedAt: "not a date" });
    expect(badgesFor(worktree, NOW)).toEqual([]);
  });

  it("reports both badges when a worktree is stale and integrated", () => {
    const worktree = row({
      dirty: true,
      pruneCandidate: true,
      lastTouchedAt: daysAgo(30),
    });
    expect(badgesFor(worktree, NOW)).toEqual(["removable", "at risk"]);
  });

  // bb's environment outlives the directory; there is no working tree left for
  // the other two rules to describe.
  it("says only 'broken' when bb's path is gone", () => {
    const worktree = row({
      bbAvailability: "unavailable",
      dirty: true,
      pruneCandidate: true,
      lastTouchedAt: daysAgo(90),
    });
    expect(badgesFor(worktree, NOW)).toEqual(["broken"]);
  });

  it("does not badge a healthy bb worktree", () => {
    expect(badgesFor(row({ bbAvailability: "available" }), NOW)).toEqual([]);
  });
});

describe("needsAttention", () => {
  it("counts any badged worktree", () => {
    expect(needsAttention(row({ pruneCandidate: true }), NOW)).toBe(true);
  });

  it("ignores an ordinary working worktree", () => {
    expect(needsAttention(row({ dirty: true }), NOW)).toBe(false);
  });
});
