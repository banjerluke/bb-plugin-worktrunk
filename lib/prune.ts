/**
 * The only module that understands `wt step prune --format json`.
 *
 * Recorded from `wt` v0.77 against a throwaway repo, since no repo on the
 * author's machine had a prune candidate. Two shapes, both a bare top-level
 * array:
 *
 *   --dry-run  { branch, branch_deleted, kind, path, reason, target }
 *   applied    { branch, branch_outcome, kind, path }
 *
 * Like the `wt list` adapter, this never throws.
 */
import { z } from "zod";

const entrySchema = z
  .object({
    branch: z.string().nullable().optional(),
    /** `worktree` also deletes a directory; `branch_only` is a ref with no checkout. */
    kind: z.string().optional(),
    path: z.string().nullable().optional(),
    /** Present on `--dry-run` only: "ancestor of" / "same commit as". */
    reason: z.string().optional(),
    target: z.string().optional(),
    branch_deleted: z.boolean().optional(),
    branch_outcome: z.string().optional(),
  })
  .loose();

export interface PruneEntry {
  branch: string | null;
  /** `null` for a branch with no worktree. */
  path: string | null;
  kind: "worktree" | "branch_only" | "unknown";
  /** "ancestor of main", or an empty string when `wt` did not say. */
  reason: string;
  /** Whether the branch ref goes too, not just the directory. */
  branchRemoved: boolean;
}

export interface PruneResult {
  entries: PruneEntry[];
  warnings: string[];
}

function adaptKind(kind: string | undefined): PruneEntry["kind"] {
  if (kind === "worktree" || kind === "branch_only") return kind;
  return "unknown";
}

function adaptReason(entry: z.infer<typeof entrySchema>): string {
  if (entry.reason === undefined) return "";
  return entry.target === undefined
    ? entry.reason
    : `${entry.reason} ${entry.target}`;
}

/** Map either prune payload into entries. Never throws. */
export function adaptPruneOutput(raw: unknown): PruneResult {
  if (!Array.isArray(raw)) {
    return { entries: [], warnings: ["Unrecognized `wt step prune` output."] };
  }

  const entries: PruneEntry[] = [];
  for (const candidate of raw) {
    const parsed = entrySchema.safeParse(candidate);
    if (!parsed.success) continue;
    const entry = parsed.data;
    entries.push({
      branch: entry.branch ?? null,
      path: entry.path ?? null,
      kind: adaptKind(entry.kind),
      reason: adaptReason(entry),
      branchRemoved:
        entry.branch_deleted === true || entry.branch_outcome === "deleted",
    });
  }

  const skipped = raw.length - entries.length;
  return {
    entries,
    warnings:
      skipped > 0 ? [`Skipped ${skipped} unreadable prune entr(ies).`] : [],
  };
}

/** Parse stdout, tolerating the progress lines `wt` writes when applying. */
export function parsePruneStdout(stdout: string): PruneResult {
  const start = stdout.indexOf("[");
  if (start === -1) {
    return { entries: [], warnings: ["`wt step prune` printed no JSON."] };
  }
  try {
    return adaptPruneOutput(JSON.parse(stdout.slice(start)));
  } catch {
    return { entries: [], warnings: ["`wt step prune` printed invalid JSON."] };
  }
}
