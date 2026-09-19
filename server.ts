/**
 * Backend entry. Owns settings, the host client, and the panel's RPC surface.
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

const SELECTED_PROJECT_KEY = "selected-project";

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
  });

  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  host.experimental_onSignal("changed", ({ payload }) => {
    bb.realtime.publish(SNAPSHOT_CHANGED, { repoPath: payload.repoPath });
  });

  async function binaryPath(): Promise<string | null> {
    const { binaryPath: configured } = await settings.get();
    return typeof configured === "string" && configured.trim() !== ""
      ? configured
      : null;
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
  ): Promise<string> {
    const project = await bb.sdk.projects.get({ projectId });
    const source = project.sources.find(
      (candidate) =>
        candidate.type === "local_path" && candidate.hostId === hostId,
    );
    if (source === undefined || source.type !== "local_path") {
      throw new Error(`Project ${projectId} has no checkout on this machine.`);
    }
    return source.path;
  }

  bb.rpc.register(rpcContract, {
    repo_snapshot: async ({ projectId }) => {
      const hostId = await primaryHostId();
      const repoPath = await repoPathFor(projectId, hostId);
      const result = await host.call(
        "list",
        { repoPath, binaryPath: await binaryPath() },
        { hostId },
      );
      return result.status === "ok"
        ? { snapshot: result.snapshot, failure: null }
        : { snapshot: null, failure: result.failure };
    },

    selected_project_get: async () => ({
      projectId:
        (await bb.storage.kv.get<string>(SELECTED_PROJECT_KEY)) ?? null,
    }),

    selected_project_set: async ({ projectId }) => {
      await bb.storage.kv.set(SELECTED_PROJECT_KEY, projectId);
      return { projectId };
    },

    open_terminal: async ({ path }) => {
      const hostId = await primaryHostId();
      const terminal = await bb.sdk.terminals.create({
        cols: 120,
        rows: 32,
        scope: { kind: "host_path", hostId, cwd: path },
      });
      // Nothing in the SDK focuses a terminal tab yet; the panel shows a toast.
      return { terminalId: terminal.id };
    },
  });

  // TODO: host-side experimental_watch on each repo's .git, plus a ~5s port
  // poll via bb.background.service. Both push through SNAPSHOT_CHANGED.

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
