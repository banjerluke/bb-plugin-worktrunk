/**
 * The types the UI renders. Nothing here mirrors worktrunk's wire format —
 * `adapter.ts` maps into these first, so a `wt` upgrade is a one-file change.
 */

/** Who is responsible for removing this worktree. Gates the row's actions. */
export type Ownership = "bb" | "user";

export interface WorktreeHead {
  sha: string;
  shortSha: string;
  subject: string;
  committedAt: string;
}

export interface Worktree {
  /** `null` when HEAD is detached. */
  branch: string | null;
  path: string;
  isMain: boolean;
  isCurrent: boolean;
  detached: boolean;
  head: WorktreeHead | null;
  dirty: boolean;
  conflicted: boolean;
  /** Commits ahead of / behind the repo's default branch. */
  ahead: number;
  behind: number;
  /** Integrated into the default branch, so `wt step prune` would remove it. */
  pruneCandidate: boolean;
  ownership: Ownership;
}

export interface RepoSnapshot {
  repoPath: string;
  defaultBranch: string | null;
  worktrees: Worktree[];
  /**
   * Rows or fields the adapter could not read. The adapter never throws: an
   * unexpected `wt` payload degrades one row and is reported here.
   */
  warnings: string[];
}
