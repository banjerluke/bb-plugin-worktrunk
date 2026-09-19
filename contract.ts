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
const badgeSchema = z.enum(["removable", "at risk", "broken"]);

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
  /**
   * Newest mtime among dirty files, falling back to the HEAD commit date when
   * clean. The host computes it; worktrunk has no equivalent field.
   */
  lastTouchedAt: z.string().nullable(),
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

const devServerSchema = z.object({
  path: z.string(),
  port: z.number(),
  command: z.string(),
  /** Ports the row collapses away — a Meteor checkout has three or four. */
  otherPorts: z.array(z.number()),
});

const pruneEntrySchema = z.object({
  branch: z.string().nullable(),
  /** `null` for a branch with no worktree. */
  path: z.string().nullable(),
  kind: z.enum(["worktree", "branch_only", "unknown"]),
  reason: z.string(),
  branchRemoved: z.boolean(),
});

const pruneResultSchema = z.object({
  entries: z.array(pruneEntrySchema),
  warnings: z.array(z.string()),
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

  /** `wt -C <repoPath> list --format json`, adapted, plus the mtime pass. */
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
   * Listening TCP sockets whose process cwd is inside one of `worktreePaths`,
   * collapsed to one row each. Separate from the `wt` surface: this spawns
   * `lsof`, which worktrunk has nothing to do with.
   */
  ports: {
    input: z.object({
      worktreePaths: z.array(z.string()),
      /**
       * Repo-relative script printing a port, run once per worktree when the
       * repo ships one. Opt-in through settings; the default must work with no
       * configuration at all.
       */
      portCommand: z.string().nullable(),
    }),
    output: z.object({
      servers: z.array(devServerSchema),
      warnings: z.array(z.string()),
    }),
  },

  /**
   * `wt step prune`, the only mutation this plugin performs. `apply: false` is
   * the native `--dry-run`, which is also the confirmation list.
   *
   * Both calls use worktrunk's default `--min-age`, so the preview describes
   * exactly what the apply will do.
   */
  prune: {
    input: z.object({
      repoPath: z.string(),
      binaryPath: z.string().nullable(),
      apply: z.boolean(),
    }),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ok"), result: pruneResultSchema }),
      z.object({ status: z.literal("failed"), failure: repoFailureSchema }),
    ]),
  },

  /**
   * Watch a repo's `.git` and emit `changed` when git state moves. Idempotent
   * per repo; `unwatch` releases it when the panel switches repos.
   */
  watch: {
    input: z.object({ repoPath: z.string() }),
    output: z.object({ watching: z.boolean(), message: z.string().nullable() }),
  },
  unwatch: {
    input: z.object({ repoPath: z.string() }),
    output: z.object({ watching: z.boolean() }),
  },
});

const threadSchema = z.object({ id: z.string(), title: z.string() });

/** One panel row: worktrunk's git state joined with bb's registry and a socket. */
const rowSchema = worktreeSchema.extend({
  /** Presence and title only. bb's sidebar already shows live agent status. */
  thread: threadSchema.nullable(),
  devServer: z
    .object({ port: z.number(), otherPorts: z.array(z.number()) })
    .nullable(),
  environmentId: z.string().nullable(),
  badges: z.array(badgeSchema),
});

export const rpcContract = defineRpcContract({
  /** Snapshot for the selected repo, joined with bb thread and port data. */
  repo_snapshot: {
    input: z.object({ projectId: z.string() }),
    output: z.object({
      repoPath: z.string().nullable(),
      defaultBranch: z.string().nullable(),
      rows: z.array(rowSchema),
      warnings: z.array(z.string()),
      failure: repoFailureSchema.nullable(),
    }),
  },

  /**
   * "N worktrees need attention in 2 other repos" — computed on panel open and
   * manual refresh only. Live cross-repo would mean a `wt list` and a watcher
   * per project for a number you glance at; the rot it hunts accrues over
   * weeks, so a minute-stale count reads the same as a live one.
   */
  attention_summary: {
    input: z.object({ excludeProjectId: z.string().nullable() }),
    output: z.object({
      repos: z.array(
        z.object({
          projectId: z.string(),
          projectName: z.string(),
          count: z.number(),
        }),
      ),
      /** Repos whose `wt list` failed; surfaced, not silently dropped. */
      unreadable: z.array(z.string()),
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

  prune_preview: {
    input: z.object({ projectId: z.string() }),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ok"), result: pruneResultSchema }),
      z.object({ status: z.literal("failed"), failure: repoFailureSchema }),
    ]),
  },
  prune_apply: {
    input: z.object({ projectId: z.string() }),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ok"), result: pruneResultSchema }),
      z.object({ status: z.literal("failed"), failure: repoFailureSchema }),
    ]),
  },

  /** Open a terminal at a worktree. Returns its title; nothing can focus it. */
  open_terminal: {
    input: z.object({ path: z.string(), label: z.string() }),
    output: z.object({ terminalId: z.string(), title: z.string() }),
  },
});

/** Host -> server push, so the panel can refresh without polling git state. */
export const hostSignals = {
  changed: { payload: z.object({ repoPath: z.string() }) },
} as const;

/** Realtime channel the panel subscribes to. */
export const SNAPSHOT_CHANGED = "worktrunk-snapshot-changed";

export type Badge = z.infer<typeof badgeSchema>;
export type Worktree = z.infer<typeof worktreeSchema>;
export type WorktreeRow = z.infer<typeof rowSchema>;
export type RepoSnapshot = z.infer<typeof repoSnapshotSchema>;
export type RepoFailure = z.infer<typeof repoFailureSchema>;
export type PruneEntry = z.infer<typeof pruneEntrySchema>;
export type PruneResult = z.infer<typeof pruneResultSchema>;
export type DevServer = z.infer<typeof devServerSchema>;
