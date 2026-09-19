/**
 * Frontend entry — the Worktrees panel.
 *
 * Read-only by design: the only mutation the plugin performs is
 * `wt step prune`, always behind its own `--dry-run` preview. Everything else
 * is a command you run in a terminal. See DESIGN.md.
 */
import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { RepoFailure, RepoSnapshot, Worktree } from "./contract";
import { rpcContract, SNAPSHOT_CHANGED } from "./contract";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Which repo the panel shows. A nav panel route carries no project context
 * (`useBbContext()` is null here), so the pick is persisted server-side and
 * seeded once from the most recently active thread.
 */
function useSelectedProject() {
  const rpc = useRpc<typeof rpcContract>();
  const sidebar = experimental_useSidebarThreads();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    rpc.call("selected_project_get", null).then((result) => {
      if (cancelled) return;
      setProjectId(result.projectId);
      setResolved(true);
    });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  // Seed from the newest thread only when nothing was stored. Deriving it live
  // would make the panel change out from under you as background threads tick.
  useEffect(() => {
    if (!resolved || projectId !== null) return;
    if (sidebar.status !== "ready") return;
    const newest = [...sidebar.threads].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    )[0];
    if (newest === undefined) return;
    setProjectId(newest.projectId);
    void rpc.call("selected_project_set", { projectId: newest.projectId });
  }, [resolved, projectId, sidebar, rpc]);

  const select = useCallback(
    (next: string) => {
      setProjectId(next);
      void rpc.call("selected_project_set", { projectId: next });
    },
    [rpc],
  );

  return { projectId, select, projects: sidebar.projects ?? [] };
}

function useSnapshot(projectId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<RepoSnapshot | null>(null);
  const [failure, setFailure] = useState<RepoFailure | null>(null);

  const refetch = useCallback(() => {
    if (projectId === null) return;
    rpc.call("repo_snapshot", { projectId }).then(
      (result) => {
        setSnapshot(result.snapshot);
        setFailure(result.failure);
      },
      (cause: unknown) => {
        setSnapshot(null);
        setFailure({
          repoPath: "",
          message: cause instanceof Error ? cause.message : String(cause),
          command: "",
        });
      },
    );
  }, [rpc, projectId]);

  useEffect(refetch, [refetch]);
  useRealtime(SNAPSHOT_CHANGED, refetch);

  return { snapshot, failure, refetch };
}

/** At most three, and only when acting on them is the obvious next step. */
function badgesFor(worktree: Worktree): string[] {
  const badges: string[] = [];
  if (worktree.pruneCandidate) badges.push("removable");
  if (worktree.conflicted) badges.push("conflicted");
  // TODO: "at risk" (dirty + untouched 14d) needs a host-side mtime pass;
  // "broken" needs the bb environment join.
  return badges;
}

function WorktreeRow({
  worktree,
  onOpenTerminal,
}: {
  worktree: Worktree;
  onOpenTerminal: () => void;
}) {
  const badges = badgesFor(worktree);
  return (
    <li className="flex items-center gap-3 border-b border-border py-2.5 text-sm last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">
            {worktree.branch ??
              `Detached at ${worktree.head?.shortSha ?? "unknown"}`}
          </span>
          {worktree.isMain ? (
            <span className="text-xs text-muted-foreground">main checkout</span>
          ) : null}
          <span
            className={cn(
              "text-xs",
              worktree.ownership === "bb"
                ? "text-muted-foreground"
                : "text-foreground/70",
            )}
          >
            {worktree.ownership === "bb" ? "bb-managed" : "user-managed"}
          </span>
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {worktree.path}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs">
        {worktree.dirty ? <span>dirty</span> : null}
        {worktree.ahead > 0 ? <span>↑{worktree.ahead}</span> : null}
        {worktree.behind > 0 ? <span>↓{worktree.behind}</span> : null}
        {badges.map((badge) => (
          <span key={badge} className="rounded bg-muted px-1.5 py-0.5">
            {badge}
          </span>
        ))}
        <Button size="sm" variant="ghost" onClick={onOpenTerminal}>
          Terminal
        </Button>
      </div>
    </li>
  );
}

function WorktreesPage() {
  const rpc = useRpc<typeof rpcContract>();
  const { projectId, select, projects } = useSelectedProject();
  const { snapshot, failure, refetch } = useSnapshot(projectId);

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-4 p-6">
      <header className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Worktrees</h1>
        <select
          className="rounded border border-border bg-background px-2 py-1 text-sm"
          value={projectId ?? ""}
          onChange={(event) => select(event.target.value)}
          aria-label="Repository"
        >
          <option value="" disabled>
            Select a repository
          </option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" onClick={refetch}>
          Refresh
        </Button>
      </header>

      {failure !== null ? (
        <div className="rounded border border-destructive/40 p-3 text-sm">
          <p>{failure.message}</p>
          {failure.command !== "" ? (
            <code className="mt-1 block text-xs text-muted-foreground">
              {failure.command}
            </code>
          ) : null}
        </div>
      ) : null}

      {snapshot !== null ? (
        <ul>
          {snapshot.worktrees.map((worktree) => (
            <WorktreeRow
              key={worktree.path}
              worktree={worktree}
              onOpenTerminal={() => {
                void rpc.call("open_terminal", { path: worktree.path });
              }}
            />
          ))}
        </ul>
      ) : null}

      {snapshot !== null && snapshot.warnings.length > 0 ? (
        <ul className="text-xs text-muted-foreground">
          {snapshot.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "worktrees",
    title: "Worktrees",
    icon: "FolderGit",
    path: "worktrees",
    component: WorktreesPage,
  });
});
