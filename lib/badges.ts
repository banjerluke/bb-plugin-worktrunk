/**
 * Badge rules — exactly three, per DESIGN.md.
 *
 * `wt list` carries far more signal than a row can. The filter is *actionable*,
 * not merely interesting: "↑17" is true of nearly every worktree on this
 * machine and implies nothing. Anything that fails that test renders as a plain
 * column instead.
 */
import type { BbAvailability } from "./types";

export type Badge = "removable" | "at risk" | "broken";

/** Just enough of a row to decide. Keeps the rules testable without a snapshot. */
export interface BadgeInput {
  dirty: boolean;
  pruneCandidate: boolean;
  isMain: boolean;
  lastTouchedAt: string | null;
  bbAvailability: BbAvailability;
}

/**
 * 14 days, deliberately not configurable. `wt step prune` defaults to
 * `--min-age 1d`, so worktrunk's own instinct is that recency is protective.
 * 7 days fires on a normal vacation; 30 is long enough that you have already
 * forgotten. A tunable threshold is one you tune once and never revisit, at
 * the cost of doubling the settings surface for one integer.
 */
export const AT_RISK_DAYS = 14;

const AT_RISK_MS = AT_RISK_DAYS * 24 * 60 * 60 * 1000;

function ageMs(timestamp: string, now: number): number | null {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? null : now - parsed;
}

/**
 * `lastTouchedAt` is the newest mtime among dirty files, falling back to the
 * HEAD commit date when the worktree is clean — see `host.ts`.
 * `head.committed_at` alone is the wrong clock: a worktree whose last commit is
 * 40 days old but which was edited yesterday is not forgotten, while one with a
 * fresh commit and uncommitted edits abandoned three weeks ago is.
 */
export function badgesFor(worktree: BadgeInput, now: number): Badge[] {
  // bb lists an environment whose path is gone; there is no working tree left
  // to be dirty or prunable, so this is the only thing worth saying about it.
  if (worktree.bbAvailability === "unavailable") return ["broken"];

  const badges: Badge[] = [];
  // The main checkout is never a prune candidate, whatever `wt` says about it.
  if (worktree.pruneCandidate && !worktree.isMain) badges.push("removable");

  if (worktree.dirty && worktree.lastTouchedAt !== null) {
    const age = ageMs(worktree.lastTouchedAt, now);
    if (age !== null && age >= AT_RISK_MS) badges.push("at risk");
  }
  return badges;
}

/** Rows a cross-repo count should mention. */
export function needsAttention(worktree: BadgeInput, now: number): boolean {
  return badgesFor(worktree, now).length > 0;
}
