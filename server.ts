/**
 * Backend entry. Owns settings, the host client, the joins, and the panel's
 * RPC surface.
 *
 * Deliberately absent in v1: agent tools and a `bb` CLI command. See DESIGN.md.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  hostContract,
  hostSignals,
  rpcContract,
  SNAPSHOT_CHANGED,
} from "./contract";
import type { PruneResult, RepoFailure } from "./contract";
import { needsAttention } from "./lib/badges";
import type { BbWorktree, ThreadRef } from "./lib/join";
import { joinRows } from "./lib/join";
import type { DevServer } from "./lib/ports";

const SELECTED_PROJECT_KEY = "selected-project";

/**
 * An `lsof` pair cannot be watched, so ports are the one thing here that polls.
 * Five seconds is fast enough that starting a dev server feels reflected and
 * slow enough that two short-lived subprocesses per interval is nothing.
 */
const PORT_POLL_MS = 5_000;

/** Cheap enough to run across every project on a manual refresh, not on a timer. */
const ATTENTION_CONCURRENCY = 4;

/**
 * A repo with six worktrees has bb, agents, and the user all touching `.git`
 * constantly, and one `wt list` costs about a second. Without a floor between
 * publishes the panel spends its whole life refetching, so the watcher's job
 * is "something moved", not "here is every event".
 */
const PUBLISH_THROTTLE_MS = 4_000;

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    binaryPath: {
      type: "string",
      label: "Path to the `wt` binary",
      description:
        "Leave empty to use `wt` from PATH. Set this if the host daemon cannot find it — GUI-launched processes inherit a shorter PATH than your shell.",
      default: "",
    },
    portCommand: {
      type: "string",
      label: "Repo-relative port script",
      description:
        "Optional. A script inside each worktree that prints the port its dev server uses, e.g. `bin/port.sh`. Only ever reorders ports that are already listening; leave empty to rely on detection alone.",
      default: "",
    },
  });

  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  /**
   * The repo the panel is showing. One at a time by design: a live view of
   * every project would mean a `wt list` and a `.git` watcher per project for
   * a number you glance at. Switching repos releases the previous one's
   * watcher rather than accumulating them.
   */
  let active: { repoPath: string; worktreePaths: string[] } | null = null;
  /**
   * Ports come from a poll, git state from a watcher. Caching the last scan
   * lets a snapshot request answer without paying for an `lsof` pair.
   */
  let portCache: DevServer[] = [];

  /** Leading-edge throttle with a trailing publish, so a change is never lost. */
  let lastPublishedAt = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;

  function publishChanged(repoPath: string): void {
    const elapsed = Date.now() - lastPublishedAt;
    if (elapsed >= PUBLISH_THROTTLE_MS) {
      lastPublishedAt = Date.now();
      bb.realtime.publish(SNAPSHOT_CHANGED, { repoPath });
      return;
    }
    if (trailing !== null) return;
    trailing = setTimeout(() => {
      trailing = null;
      lastPublishedAt = Date.now();
      bb.realtime.publish(SNAPSHOT_CHANGED, { repoPath });
    }, PUBLISH_THROTTLE_MS - elapsed);
  }

  host.experimental_onSignal("changed", ({ payload }) => {
    publishChanged(payload.repoPath);
  });

  async function setting(name: "binaryPath" | "portCommand"): Promise<string | null> {
    const values = await settings.get();
    const value = values[name];
    return typeof value === "string" && value.trim() !== "" ? value : null;
  }

  async function primaryHostId(): Promise<string> {
    const { primaryHostId: hostId } = await bb.sdk.system.config();
    if (hostId === null) {
      throw new Error("No primary machine is configured.");
    }
    return hostId;
  }

  /** A project's checkout path on a given machine. */
  async function repoPathFor(
    projectId: string,
    hostId: string,
  ): Promise<string | null> {
    const project = await bb.sdk.projects.get({ projectId });
    const source = project.sources.find(
      (candidate) =>
        candidate.type === "local_path" && candidate.hostId === hostId,
    );
    return source === undefined || source.type !== "local_path"
      ? null
      : source.path;
  }

  /** bb's own worktree discovery, reduced to what the join needs. */
  async function bbWorktreesFor(
    projectId: string,
    hostId: string,
  ): Promise<BbWorktree[]> {
    try {
      const { worktrees } = await bb.sdk.projects.worktrees({ projectId });
      return worktrees
        .filter((entry) => entry.hostId === hostId)
        .map((entry) => ({
          path:
            entry.availability.kind === "selectable"
              ? entry.availability.canonicalPath
              : entry.path,
          branch:
            entry.checkout.kind === "branch" ? entry.checkout.branchName : null,
          environmentId: entry.environmentId,
          ownership: entry.ownership === "bb-managed" ? "bb" : "user",
          available: entry.availability.kind === "selectable",
        }));
    } catch (error) {
      // bb's own discovery failing must degrade the join, not the panel.
      bb.log.warn(`bb worktree discovery failed: ${String(error)}`);
      return [];
    }
  }

  async function threadsFor(projectId: string): Promise<ThreadRef[]> {
    try {
      const threads = await bb.sdk.threads.list({ projectId, archived: false });
      return threads.map((thread) => ({
        id: thread.id,
        title: thread.title ?? thread.titleFallback ?? "Untitled thread",
        environmentId: thread.environmentId,
        environmentPath: thread.environmentPath,
        updatedAt: thread.updatedAt,
      }));
    } catch (error) {
      bb.log.warn(`thread lookup failed: ${String(error)}`);
      return [];
    }
  }

  /**
   * Point the git-state watcher and the port poll at one repo. Idempotent, so
   * every snapshot request can call it.
   */
  async function activate(
    repoPath: string,
    worktreePaths: string[],
    hostId: string,
  ): Promise<void> {
    if (active?.repoPath === repoPath) {
      active = { repoPath, worktreePaths };
      return;
    }
    const previous = active;
    active = { repoPath, worktreePaths };
    portCache = [];
    if (previous !== null) {
      await host
        .call("unwatch", { repoPath: previous.repoPath }, { hostId })
        .catch(() => undefined);
    }
    const result = await host.call("watch", { repoPath }, { hostId });
    if (!result.watching) {
      bb.log.warn(
        `Could not watch ${repoPath}: ${result.message ?? "unknown reason"}`,
      );
    }
  }

  async function refreshPorts(
    worktreePaths: string[],
    hostId: string,
  ): Promise<DevServer[]> {
    const { servers, warnings } = await host.call(
      "ports",
      { worktreePaths, portCommand: await setting("portCommand") },
      { hostId },
    );
    for (const warning of warnings) bb.log.warn(warning);
    portCache = servers;
    return servers;
  }

  bb.rpc.register(rpcContract, {
    repo_snapshot: async ({ projectId }) => {
      const hostId = await primaryHostId();
      const repoPath = await repoPathFor(projectId, hostId);
      if (repoPath === null) {
        return {
          repoPath: null,
          defaultBranch: null,
          rows: [],
          warnings: [],
          failure: {
            repoPath: "",
            message: "This project has no checkout on the primary machine.",
            command: "",
          },
        };
      }

      const result = await host.call(
        "list",
        { repoPath, binaryPath: await setting("binaryPath") },
        { hostId },
      );

      const [bbWorktrees, threads] = await Promise.all([
        bbWorktreesFor(projectId, hostId),
        threadsFor(projectId),
      ]);

      if (result.status === "failed") {
        // bb still knows about its own worktrees when `wt` cannot be read, so
        // the panel shows what it can beside the error row.
        return {
          repoPath,
          defaultBranch: null,
          rows: joinRows({
            worktrees: [],
            bbWorktrees,
            threads,
            servers: active?.repoPath === repoPath ? portCache : [],
            now: Date.now(),
          }),
          warnings: [],
          failure: result.failure,
        };
      }

      const { snapshot } = result;
      const worktreePaths = snapshot.worktrees.map((worktree) => worktree.path);
      await activate(repoPath, worktreePaths, hostId);

      const servers =
        portCache.length > 0
          ? portCache
          : await refreshPorts(worktreePaths, hostId).catch(() => []);

      return {
        repoPath,
        defaultBranch: snapshot.defaultBranch,
        rows: joinRows({
          worktrees: snapshot.worktrees,
          bbWorktrees,
          threads,
          servers,
          now: Date.now(),
        }),
        warnings: snapshot.warnings,
        failure: null,
      };
    },

    attention_summary: async ({ excludeProjectId }) => {
      const hostId = await primaryHostId();
      const binaryPath = await setting("binaryPath");
      const projects = await bb.sdk.projects.list();

      const targets: { id: string; name: string; repoPath: string }[] = [];
      for (const project of projects) {
        if (project.id === excludeProjectId) continue;
        const repoPath = await repoPathFor(project.id, hostId).catch(() => null);
        if (repoPath !== null) {
          targets.push({ id: project.id, name: project.name, repoPath });
        }
      }

      const repos: { projectId: string; projectName: string; count: number }[] = [];
      const unreadable: string[] = [];
      const now = Date.now();

      // Bounded concurrency: this is N `wt list` calls inside one 30s RPC.
      for (let start = 0; start < targets.length; start += ATTENTION_CONCURRENCY) {
        const batch = targets.slice(start, start + ATTENTION_CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (target) => {
            try {
              return {
                target,
                result: await host.call(
                  "list",
                  { repoPath: target.repoPath, binaryPath },
                  { hostId },
                ),
              };
            } catch {
              return { target, result: null };
            }
          }),
        );
        for (const { target, result } of results) {
          if (result === null || result.status === "failed") {
            unreadable.push(target.name);
            continue;
          }
          const count = result.snapshot.worktrees.filter((worktree) =>
            needsAttention({ ...worktree, bbAvailability: null }, now),
          ).length;
          if (count > 0) {
            repos.push({
              projectId: target.id,
              projectName: target.name,
              count,
            });
          }
        }
      }

      return { repos: repos.sort((a, b) => b.count - a.count), unreadable };
    },

    selected_project_get: async () => ({
      projectId:
        (await bb.storage.kv.get<string>(SELECTED_PROJECT_KEY)) ?? null,
    }),

    selected_project_set: async ({ projectId }) => {
      await bb.storage.kv.set(SELECTED_PROJECT_KEY, projectId);
      return { projectId };
    },

    prune_preview: async ({ projectId }) => prune(projectId, false),
    prune_apply: async ({ projectId }) => prune(projectId, true),

    open_terminal: async ({ path, label }) => {
      const hostId = await primaryHostId();
      const terminal = await bb.sdk.terminals.create({
        cols: 120,
        rows: 32,
        scope: { kind: "host_path", hostId, cwd: path },
        title: label,
      });
      // Nothing in the SDK focuses a terminal tab yet; the panel shows a toast
      // naming this session so the user can find it.
      return { terminalId: terminal.id, title: terminal.title };
    },
  });

  async function prune(
    projectId: string,
    apply: boolean,
  ): Promise<
    | { status: "ok"; result: PruneResult }
    | { status: "failed"; failure: RepoFailure }
  > {
    const hostId = await primaryHostId();
    const repoPath = await repoPathFor(projectId, hostId);
    if (repoPath === null) {
      return {
        status: "failed",
        failure: {
          repoPath: "",
          message: "This project has no checkout on the primary machine.",
          command: "",
        },
      };
    }
    const result = await host.call(
      "prune",
      { repoPath, binaryPath: await setting("binaryPath"), apply },
      { hostId },
    );
    if (apply && result.status === "ok") {
      portCache = [];
      publishChanged(repoPath);
    }
    return result;
  }

  /**
   * `wt` resolving is the failure that actually gets hit: GUI-launched daemons
   * inherit a short PATH. Probe once at load rather than turning every row
   * into a mystery.
   */
  bb.background.service("probe", {
    async start(signal) {
      try {
        const hostId = await primaryHostId();
        const result = await host.call(
          "probe",
          { binaryPath: await setting("binaryPath") },
          { hostId },
        );
        if (result.status === "missing") {
          bb.status.needsConfiguration(
            `Could not run \`wt\`. Set its absolute path in this plugin's settings, then run \`bb plugin reload ${bb.pluginId}\`. (${result.message})`,
          );
        } else {
  bb.log.info(`worktrunk resolved: ${result.version}`);
        }
      } catch (error) {
        bb.log.warn(`probe failed: ${String(error)}`);
      }
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });

  bb.background.service("ports", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          // Nothing to poll until the panel has asked for a repo at least once.
          const current = active;
          if (current !== null && current.worktreePaths.length > 0) {
            const hostId = await primaryHostId();
            const before = JSON.stringify(portCache);
            const after = JSON.stringify(
              await refreshPorts(current.worktreePaths, hostId),
            );
            // Only wake the panel when a port actually appeared or vanished.
            if (before !== after) publishChanged(current.repoPath);
          }
        } catch (error) {
          bb.log.debug(`port poll failed: ${String(error)}`);
        }
        await sleep(PORT_POLL_MS, signal);
      }
    },
  });

  bb.onDispose(() => {
    if (trailing !== null) clearTimeout(trailing);
    bb.log.info("disposed");
  });
}

/**
 * Resolves early on abort. A service whose sleep ignores the signal makes
 * reload report "degraded" while the daemon waits out the interval.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
