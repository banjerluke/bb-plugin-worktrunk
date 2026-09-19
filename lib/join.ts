/**
 * The join at the heart of the panel: worktrunk's git state, bb's registry,
 * and a listening socket, reduced to one row per worktree.
 *
 * This is the whole reason the panel lives inside bb rather than beside it.
 * `wt list` knows git state and nothing about threads; bb's sidebar knows
 * threads and nothing about git state; neither can render
 *
 *   feat/x · ↑3 · dirty · *Keyboard integration* · dev server on :25638
 *
 * Kept pure and apart from `server.ts` so the merge rules are testable without
 * a running bb.
 */
import type { Badge } from "./badges";
import { badgesFor } from "./badges";
import type { DevServer } from "./ports";
import type { BbAvailability, Ownership, Worktree } from "./types";

/** One row of `bb.sdk.projects.worktrees()` — bb's own discovery. */
export interface BbWorktree {
  path: string;
  /** bb knows the branch even when the directory is gone. */
  branch: string | null;
  environmentId: string | null;
  ownership: Ownership;
  /** False when bb still lists the environment but the path is gone. */
  available: boolean;
}

/** Enough of a bb thread to name the worktree's owner. */
export interface ThreadRef {
  id: string;
  title: string;
  environmentId: string | null;
  environmentPath: string | null;
  updatedAt: number;
}

export interface WorktreeRow extends Worktree {
  /** Presence and title only. bb's sidebar already shows live agent status. */
  thread: { id: string; title: string } | null;
  devServer: { port: number; otherPorts: number[] } | null;
  environmentId: string | null;
  badges: Badge[];
}

/** Paths arrive from three sources; only a trailing slash differs in practice. */
function normalize(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function availability(entry: BbWorktree | undefined): BbAvailability {
  if (entry === undefined) return null;
  return entry.available ? "available" : "unavailable";
}

/**
 * Index threads by environment, newest first. A worktree outlives the threads
 * that used it, so several may match; the most recently updated one is the
 * answer to "who is working here".
 */
function threadIndex(threads: readonly ThreadRef[]): {
  byEnvironment: Map<string, ThreadRef>;
  byPath: Map<string, ThreadRef>;
} {
  const byEnvironment = new Map<string, ThreadRef>();
  const byPath = new Map<string, ThreadRef>();

  for (const thread of [...threads].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (thread.environmentId !== null && !byEnvironment.has(thread.environmentId)) {
      byEnvironment.set(thread.environmentId, thread);
    }
    if (thread.environmentPath !== null) {
      const path = normalize(thread.environmentPath);
      if (!byPath.has(path)) byPath.set(path, thread);
    }
  }
  return { byEnvironment, byPath };
}

/**
 * A row built from bb's registry alone.
 *
 * Two cases reach it. A bb environment whose directory is gone never appears
 * in `wt list` — git has forgotten it too — and surfacing it is the only way
 * the *broken* badge can ever fire. And when `wt` itself cannot be run, bb's
 * registry is all there is, so the panel shows that beside the error row
 * rather than going blank.
 */
function registryRow(entry: BbWorktree): Worktree {
  return {
    branch: entry.branch,
    path: entry.path,
    isMain: false,
    isCurrent: false,
    detached: false,
    head: null,
    dirty: false,
    conflicted: false,
    ahead: 0,
    behind: 0,
    pruneCandidate: false,
    ownership: entry.ownership,
    lastTouchedAt: null,
  };
}

export interface JoinInput {
  worktrees: readonly Worktree[];
  bbWorktrees: readonly BbWorktree[];
  threads: readonly ThreadRef[];
  servers: readonly DevServer[];
  now: number;
}

/**
 * Sorted main-checkout first, then by recency. The main checkout anchors the
 * list — it is never removable, never at risk, and is what every other row is
 * measured against — so letting an old commit date sink it below a worktree
 * created this morning would only cost a scan.
 */
function compare(a: WorktreeRow, b: WorktreeRow): number {
  if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
  const aTime = a.lastTouchedAt === null ? 0 : Date.parse(a.lastTouchedAt);
  const bTime = b.lastTouchedAt === null ? 0 : Date.parse(b.lastTouchedAt);
  const aValid = Number.isNaN(aTime) ? 0 : aTime;
  const bValid = Number.isNaN(bTime) ? 0 : bTime;
  if (aValid !== bValid) return bValid - aValid;
  return a.path.localeCompare(b.path);
}

export function joinRows(input: JoinInput): WorktreeRow[] {
  const bbByPath = new Map(
    input.bbWorktrees.map((entry) => [normalize(entry.path), entry]),
  );
  const serversByPath = new Map(
    input.servers.map((server) => [normalize(server.path), server]),
  );
  const { byEnvironment, byPath } = threadIndex(input.threads);

  const seen = new Set<string>();
  const rows: WorktreeRow[] = [];

  const add = (worktree: Worktree): void => {
    const path = normalize(worktree.path);
    seen.add(path);
    const bb = bbByPath.get(path);
    const environmentId = bb?.environmentId ?? null;
    const thread =
      (environmentId === null ? undefined : byEnvironment.get(environmentId)) ??
      byPath.get(path) ??
      null;
    const server = serversByPath.get(path);

    rows.push({
      ...worktree,
      // bb's own discovery is authoritative about who created a worktree; the
      // adapter's path heuristic only covers what bb never saw.
      ownership: bb?.ownership ?? worktree.ownership,
      environmentId,
      thread: thread === null ? null : { id: thread.id, title: thread.title },
      devServer:
        server === undefined
          ? null
          : { port: server.port, otherPorts: server.otherPorts },
      badges: badgesFor(
        { ...worktree, bbAvailability: availability(bb) },
        input.now,
      ),
    });
  };

  for (const worktree of input.worktrees) add(worktree);
  for (const entry of input.bbWorktrees) {
    if (seen.has(normalize(entry.path))) continue;
    add(registryRow(entry));
  }

  return rows.sort(compare);
}
