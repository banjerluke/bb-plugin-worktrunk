/**
 * Host entry: the only place a subprocess is spawned.
 *
 * Runs on the enrolled machine under the host daemon, which inherits a short
 * PATH — so an explicit binary path from settings always wins over `wt`.
 *
 * Three spawn surfaces, deliberately separate. `wt` is allowlisted by
 * subcommand. `git` and `lsof` are fixed argument vectors built here, never
 * assembled from panel input: they exist because worktrunk answers neither
 * "when was this last edited" nor "what is it serving".
 */
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { hostContract, hostSignals } from "./contract";
import { adaptListOutput } from "./lib/adapter";
import { parseStatusPaths } from "./lib/git-status";
import { collapseToDevServers, parseCwds, parseListeners } from "./lib/ports";
import { parsePruneStdout } from "./lib/prune";
import type { RepoSnapshot, Worktree } from "./lib/types";

const run = promisify(execFile);

/**
 * The `wt` subcommands this plugin may run. The allowlist is a type, not a
 * scan of the argument vector: an argument that merely looks like a
 * subcommand — `-C <path>`'s value, say — can never be mistaken for one.
 * Widening this union is a security decision.
 */
type Subcommand = "list" | "step";

const DEFAULT_BINARY = "wt";
const TIMEOUT_MS = 20_000;
const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * `lsof` lives in `/usr/sbin` and `git` in `/usr/bin`, both of which a
 * GUI-launched daemon's PATH routinely omits. Try absolute paths, then PATH.
 */
const LSOF_CANDIDATES = ["/usr/sbin/lsof", "/usr/bin/lsof", "lsof"];
const GIT_CANDIDATES = ["/usr/bin/git", "git"];

/**
 * A worktree with more dirty files than this is plainly being worked on, so
 * the exact newest mtime stops mattering. Bounds the stat pass.
 */
const MAX_STATTED_FILES = 500;

/** `wt step prune` removes directories; give it more room than a read. */
const PRUNE_TIMEOUT_MS = 120_000;

function binary(binaryPath: string | null): string {
  return binaryPath === null || binaryPath.trim() === ""
    ? DEFAULT_BINARY
    : binaryPath;
}

function formatCommand(bin: string, args: string[]): string {
  return [bin, ...args].join(" ");
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

interface WtRequest {
  binaryPath: string | null;
  repoPath: string;
  subcommand: Subcommand;
  /** Everything after the subcommand. Never carries another subcommand. */
  args: readonly string[];
  /** `wt` prompts for approval on mutations; a host RPC cannot answer. */
  yes?: boolean;
  signal: AbortSignal;
  timeout?: number;
}

/** The argument vector, shown verbatim in error rows so the user can copy it. */
function wtArgv(request: WtRequest): string[] {
  return [
    ...(request.yes === true ? ["-y"] : []),
    "-C",
    request.repoPath,
    request.subcommand,
    ...request.args,
  ];
}

async function wt(request: WtRequest): Promise<string> {
  const { stdout } = await run(binary(request.binaryPath), wtArgv(request), {
    signal: request.signal,
    timeout: request.timeout ?? TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    // The daemon's environment is already sanitized; do not inherit a shell.
    shell: false,
  });
  return stdout;
}

/** Run the first of `candidates` that exists, tolerating a useful non-zero exit. */
async function spawnFirst(
  candidates: readonly string[],
  args: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const { stdout } = await run(candidate, args, {
        signal,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        shell: false,
      });
      return stdout;
    } catch (error) {
      // `lsof` exits 1 when a pid in the batch has already gone, and still
      // prints everything it did find.
      const stdout = (error as { stdout?: string }).stdout;
      if (typeof stdout === "string" && stdout !== "") return stdout;
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not run \`${candidates[0] ?? ""}\`.`);
}

/**
 * Newest mtime among a worktree's dirty files. The clean case keeps the HEAD
 * commit date the adapter already seeded, because a clean worktree has no
 * edited file to ask about.
 */
async function lastTouchedAt(
  worktree: Worktree,
  signal: AbortSignal,
): Promise<string | null> {
  if (!worktree.dirty) return worktree.lastTouchedAt;

  let paths: string[];
  try {
    const stdout = await spawnFirst(
      GIT_CANDIDATES,
      ["-C", worktree.path, "status", "--porcelain=v1", "-z"],
      signal,
    );
    paths = parseStatusPaths(stdout).slice(0, MAX_STATTED_FILES);
  } catch {
    return worktree.lastTouchedAt;
  }

  const stats = await Promise.all(
    paths.map(async (path) => {
      try {
        return (await stat(join(worktree.path, path))).mtimeMs;
      } catch {
        // Deleted, or a symlink to nowhere. It says nothing about recency.
        return null;
      }
    }),
  );

  let newest = 0;
  for (const mtime of stats) {
    if (mtime !== null && mtime > newest) newest = mtime;
  }
  return newest === 0
    ? worktree.lastTouchedAt
    : new Date(newest).toISOString();
}

async function withMtimes(
  snapshot: RepoSnapshot,
  signal: AbortSignal,
): Promise<RepoSnapshot> {
  const worktrees = await Promise.all(
    snapshot.worktrees.map(async (worktree) => ({
      ...worktree,
      lastTouchedAt: await lastTouchedAt(worktree, signal),
    })),
  );
  return { ...snapshot, worktrees };
}

/**
 * A repo-supplied port script, when the user opted into one. `sm-app` ships
 * `bin/port.sh`; most repos ship nothing, which is why this is an override and
 * not the mechanism.
 */
async function portFromCommand(
  worktreePath: string,
  portCommand: string,
  signal: AbortSignal,
): Promise<number | null> {
  const script = join(worktreePath, portCommand);
  try {
    const { stdout } = await run(script, [], {
      cwd: worktreePath,
      signal,
      timeout: 5_000,
      shell: false,
    });
    const port = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

export function createWorktrunkHostEntry() {
  /** One watcher per repo, shared across panel sessions. */
  const watchers = new Map<
    string,
    { dispose: () => Promise<void>; lease: { dispose: () => Promise<void> } }
  >();

  return experimental_defineHostEntry({
    contract: hostContract,
    experimental_signals: hostSignals,
    handlers: {
      async probe({ binaryPath }, context) {
        const bin = binary(binaryPath);
        try {
          const { stdout } = await run(bin, ["--version"], {
            signal: context.signal,
            timeout: TIMEOUT_MS,
          });
          return {
            status: "ok",
            resolvedPath: bin,
            version: stdout.trim(),
          } as const;
        } catch (error) {
          return {
            status: "missing",
            message: message(error, `Could not run \`${bin} --version\`.`),
          } as const;
        }
      },

      async list({ repoPath, binaryPath }, context) {
        const request = {
          binaryPath,
          repoPath,
          subcommand: "list",
          args: ["--format", "json"],
          signal: context.signal,
        } as const;
        try {
          const snapshot = adaptListOutput(
            JSON.parse(await wt(request)),
            repoPath,
          );
          return {
            status: "ok",
            snapshot: await withMtimes(snapshot, context.signal),
          } as const;
        } catch (error) {
          return {
            status: "failed",
            failure: {
              repoPath,
              message: message(error, String(error)),
              command: formatCommand(binary(binaryPath), wtArgv(request)),
            },
          } as const;
        }
      },

      async ports({ worktreePaths, portCommand }, context) {
        if (worktreePaths.length === 0) return { servers: [], warnings: [] };

        let servers;
        try {
          const listeners = parseListeners(
            await spawnFirst(
              LSOF_CANDIDATES,
              ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcRn"],
              context.signal,
            ),
          );
          const pids = [...new Set(listeners.map((l) => l.pid))];
          if (pids.length === 0) return { servers: [], warnings: [] };

          // One batched call, not one per pid: this runs every five seconds.
          const cwds = parseCwds(
            await spawnFirst(
              LSOF_CANDIDATES,
              ["-a", "-p", pids.join(","), "-d", "cwd", "-F", "pn"],
              context.signal,
            ),
          );
          servers = collapseToDevServers(listeners, cwds, worktreePaths);
        } catch (error) {
          return {
            servers: [],
            warnings: [
              `Could not list dev servers: ${message(error, "lsof failed.")}`,
            ],
          };
        }

        if (portCommand === null || portCommand.trim() === "") {
          return { servers, warnings: [] };
        }

        // An override only reorders what lsof already found: a port the repo
        // names but nothing is listening on is not a running dev server.
        const overridden = await Promise.all(
          servers.map(async (server) => {
            const declared = await portFromCommand(
              server.path,
              portCommand.trim(),
              context.signal,
            );
            if (declared === null || declared === server.port) return server;
            const all = [server.port, ...server.otherPorts];
            if (!all.includes(declared)) return server;
            return {
              ...server,
              port: declared,
              otherPorts: all.filter((port) => port !== declared),
            };
          }),
        );
        return { servers: overridden, warnings: [] };
      },

      async prune({ repoPath, binaryPath, apply }, context) {
        // Both paths take worktrunk's default --min-age, so the preview is a
        // truthful description of what applying will do.
        const request = {
          binaryPath,
          repoPath,
          subcommand: "step",
          // `--foreground` matters: without it `wt` backgrounds the removal and
          // returns before the worktrees are gone, so the panel would refresh
          // onto state that is still changing.
          args: apply
            ? ["prune", "--foreground", "--format", "json"]
            : ["prune", "--dry-run", "--format", "json"],
          yes: apply,
          signal: context.signal,
          timeout: apply ? PRUNE_TIMEOUT_MS : TIMEOUT_MS,
        } as const;
        try {
          return {
            status: "ok",
            result: parsePruneStdout(await wt(request)),
          } as const;
        } catch (error) {
          return {
            status: "failed",
            failure: {
              repoPath,
              message: message(error, String(error)),
              command: formatCommand(binary(binaryPath), wtArgv(request)),
            },
          } as const;
        }
      },

      async watch({ repoPath }, context) {
        if (watchers.has(repoPath)) {
          return { watching: true, message: null };
        }
        try {
          // A watch alone retains the worker, but the lease keeps it alive
          // through the gap where a watch is being replaced.
          const lease = context.experimental_retainWorker();
          const subscription = await context.experimental_watch(
            {
              rootPath: join(repoPath, ".git"),
              // Loose objects and index locks churn constantly and say nothing
              // about which worktrees exist or what state they are in.
              ignoredPaths: ["objects", "logs", "index.lock", "wt"],
              debounceMs: 300,
              maxWaitMs: 2_000,
            },
            (event) => {
              if (event.kind === "watch-error") return;
              // The originating call has long since returned; a rejection here
              // would surface as an unhandled crash of the whole worker.
              context
                .experimental_emitSignal("changed", { repoPath })
                .catch(() => {});
            },
          );
          watchers.set(repoPath, {
            dispose: () => subscription.dispose(),
            lease,
          });
          return { watching: true, message: null };
        } catch (error) {
          return {
            watching: false,
            message: message(error, "Could not watch this repo."),
          };
        }
      },

      async unwatch({ repoPath }) {
        const watcher = watchers.get(repoPath);
        if (watcher === undefined) return { watching: false };
        watchers.delete(repoPath);
        await watcher.dispose();
        await watcher.lease.dispose();
        return { watching: false };
      },
    },

    async dispose() {
      for (const watcher of watchers.values()) {
        await watcher.dispose();
        await watcher.lease.dispose();
      }
      watchers.clear();
    },
  });
}

export default createWorktrunkHostEntry();
