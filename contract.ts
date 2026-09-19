/**
 * Wire contracts. `hostContract` is server -> host daemon (where `wt` runs);
 * `rpcContract` is panel -> server.
 *
 * Host RPC is single-shot validated JSON with a 30s default timeout and no
 * streaming. Nothing long-running or interactive belongs here — see DESIGN.md.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const ownershipSchema = z.enum(["bb", "user"]);

const worktreeSchema = z.object({
  branch: z.string().nullable(),
  path: z.string(),
  isMain: z.boolean(),
  isCurrent: z.boolean(),
  detached: z.boolean(),
  head: z
    .object({
      sha: z.string(),
      shortSha: z.string(),
      subject: z.string(),
      committedAt: z.string(),
    })
    .nullable(),
  dirty: z.boolean(),
  conflicted: z.boolean(),
  ahead: z.number(),
  behind: z.number(),
  pruneCandidate: z.boolean(),
  ownership: ownershipSchema,
});

const repoSnapshotSchema = z.object({
  repoPath: z.string(),
  defaultBranch: z.string().nullable(),
  worktrees: z.array(worktreeSchema),
  warnings: z.array(z.string()),
});

/** A repo that could not be read. Rendered as an error row, never a global gate. */
const repoFailureSchema = z.object({
  repoPath: z.string(),
  message: z.string(),
  /** The exact command that failed, for the copy button. */
  command: z.string(),
});

export const hostContract = defineRpcContract({
  /** Resolve the `wt` binary and report its version. */
  probe: {
    input: z.object({ binaryPath: z.string().nullable() }),
    output: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("ok"),
        resolvedPath: z.string(),
        version: z.string(),
      }),
      z.object({ status: z.literal("missing"), message: z.string() }),
    ]),
  },

  /** `wt -C <repoPath> list --format json`, adapted. */
  list: {
    input: z.object({
      repoPath: z.string(),
      binaryPath: z.string().nullable(),
    }),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ok"), snapshot: repoSnapshotSchema }),
      z.object({ status: z.literal("failed"), failure: repoFailureSchema }),
    ]),
  },

  /**
   * `wt step prune --dry-run --format json`. The preview half of the only
   * mutation this plugin performs.
   */
  prunePreview: {
    input: z.object({
      repoPath: z.string(),
      binaryPath: z.string().nullable(),
    }),
    output: z.object({ paths: z.array(z.string()), raw: z.string() }),
  },
});

export const rpcContract = defineRpcContract({
  /** Snapshot for the selected repo, joined with bb thread data. */
  repo_snapshot: {
    input: z.object({ projectId: z.string() }),
    output: z.object({
      snapshot: repoSnapshotSchema.nullable(),
      failure: repoFailureSchema.nullable(),
    }),
  },

  /** The repo the panel last showed, persisted in bb.storage.kv. */
  selected_project_get: {
    input: z.null(),
    output: z.object({ projectId: z.string().nullable() }),
  },
  selected_project_set: {
    input: z.object({ projectId: z.string() }),
    output: z.object({ projectId: z.string() }),
  },

  /** Open a terminal at a worktree. Returns the id; nothing can focus it yet. */
  open_terminal: {
    input: z.object({ path: z.string() }),
    output: z.object({ terminalId: z.string() }),
  },
});

/** Host -> server push, so the panel can refresh without polling git state. */
export const hostSignals = {
  changed: { payload: z.object({ repoPath: z.string() }) },
} as const;

/** Realtime channel the panel subscribes to. */
export const SNAPSHOT_CHANGED = "worktrunk-snapshot-changed";

export type Worktree = z.infer<typeof worktreeSchema>;
export type RepoSnapshot = z.infer<typeof repoSnapshotSchema>;
export type RepoFailure = z.infer<typeof repoFailureSchema>;
