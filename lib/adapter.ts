/**
 * The only module that understands `wt list --format json`.
 *
 * Two rules, both load-bearing:
 *  1. Nothing outside this file reads a raw worktrunk field.
 *  2. `adaptListOutput` never throws. worktrunk ships on its own cadence; an
 *     unexpected payload must degrade one row, not blank the panel.
 */
import { z } from "zod";
import type { Ownership, RepoSnapshot, Worktree } from "./types";

/** The schema version this adapter was written against (`wt` >= 0.77). */
export const SUPPORTED_WT_SCHEMA = 2;

/** bb's managed worktrees live under the worktree plugin's host-data directory. */
const BB_MANAGED_PATH_SEGMENT =
  "/plugins/environment-git-worktree/host-data/worktrees/";

/**
 * `default_branch.integration.reason` is the structured form of what `wt list`
 * renders as `_` (same commit) and `⊂` (content integrated); both correspond
 * exactly to what `wt step prune --dry-run` offered on a recorded repo. The
 * symbols remain a fallback for a payload that omits the structured field.
 */
const INTEGRATION_REASONS = ["same_commit", "ancestor", "squashed", "rebased"];
const PRUNE_SYMBOLS = ["_", "⊂"];

const changesSchema = z
  .object({
    staged: z.boolean().optional(),
    modified: z.boolean().optional(),
    untracked: z.boolean().optional(),
    renamed: z.boolean().optional(),
    deleted: z.boolean().optional(),
    conflicted: z.boolean().optional(),
  })
  .loose();

const itemSchema = z
  .object({
    branch: z.string().nullable().optional(),
    head: z
      .object({
        sha: z.string(),
        short_sha: z.string(),
        subject: z.string(),
        committed_at: z.string(),
      })
      .loose()
      .optional(),
    worktree: z
      .object({
        path: z.string(),
        main: z.boolean().optional(),
        current: z.boolean().optional(),
        detached: z.boolean().optional(),
        changes: changesSchema.optional(),
      })
      .loose()
      .optional(),
    default_branch: z
      .object({
        ahead: z.number().optional(),
        behind: z.number().optional(),
        integration: z
          .object({ reason: z.string().optional() })
          .loose()
          .nullable()
          .optional(),
      })
      .loose()
      .nullable()
      .optional(),
    display: z
      .object({ state: z.string().optional(), symbols: z.string().optional() })
      .loose()
      .optional(),
  })
  .loose();

const listSchema = z
  .object({
    schema: z.number().optional(),
    repo: z
      .object({ default_branch: z.string().nullable().optional() })
      .loose()
      .optional(),
    items: z.array(z.unknown()).optional(),
  })
  .loose();

function ownershipForPath(path: string): Ownership {
  return path.includes(BB_MANAGED_PATH_SEGMENT) ? "bb" : "user";
}

function isDirty(changes: z.infer<typeof changesSchema> | undefined): boolean {
  if (changes === undefined) return false;
  return (
    changes.staged === true ||
    changes.modified === true ||
    changes.untracked === true ||
    changes.renamed === true ||
    changes.deleted === true ||
    changes.conflicted === true
  );
}

function isPruneCandidate(
  item: z.infer<typeof itemSchema>,
  symbols: string,
): boolean {
  const reason = item.default_branch?.integration?.reason;
  if (reason !== undefined) return INTEGRATION_REASONS.includes(reason);
  return PRUNE_SYMBOLS.some((symbol) => symbols.includes(symbol));
}

function adaptItem(raw: unknown): Worktree | null {
  const parsed = itemSchema.safeParse(raw);
  if (!parsed.success) return null;
  const item = parsed.data;
  const worktree = item.worktree;
  // A row with no worktree is a branch without a checkout. Nothing to show,
  // nothing to act on.
  if (worktree === undefined) return null;

  const symbols = item.display?.symbols ?? "";
  const head = item.head;

  return {
    branch: item.branch ?? null,
    path: worktree.path,
    isMain: worktree.main === true,
    isCurrent: worktree.current === true,
    detached: worktree.detached === true,
    head:
      head === undefined
        ? null
        : {
            sha: head.sha,
            shortSha: head.short_sha,
            subject: head.subject,
            committedAt: head.committed_at,
          },
    dirty: isDirty(worktree.changes),
    conflicted: worktree.changes?.conflicted === true,
    ahead: item.default_branch?.ahead ?? 0,
    behind: item.default_branch?.behind ?? 0,
    pruneCandidate: isPruneCandidate(item, symbols),
    ownership: ownershipForPath(worktree.path),
    // The clean-worktree clock. `host.ts` replaces this with the newest mtime
    // among dirty files when there are any.
    lastTouchedAt: head?.committed_at ?? null,
  };
}

/**
 * Map one `wt list --format json` payload into a snapshot. Never throws;
 * everything it could not read lands in `warnings`.
 */
export function adaptListOutput(raw: unknown, repoPath: string): RepoSnapshot {
  const warnings: string[] = [];
  const parsed = listSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      repoPath,
      defaultBranch: null,
      worktrees: [],
      warnings: ["Unrecognized `wt list` output."],
    };
  }

  const { schema, repo, items } = parsed.data;
  if (schema !== undefined && schema !== SUPPORTED_WT_SCHEMA) {
    warnings.push(
      `wt list schema ${schema}; this plugin targets ${SUPPORTED_WT_SCHEMA}. Some fields may be missing.`,
    );
  }

  const worktrees: Worktree[] = [];
  for (const entry of items ?? []) {
    const worktree = adaptItem(entry);
    if (worktree === null) continue;
    worktrees.push(worktree);
  }

  const skipped = (items ?? []).length - worktrees.length;
  if (skipped > 0) {
    warnings.push(`Skipped ${skipped} row(s) without a usable worktree.`);
  }

  return {
    repoPath,
    defaultBranch: repo?.default_branch ?? null,
    worktrees,
    warnings,
  };
}
