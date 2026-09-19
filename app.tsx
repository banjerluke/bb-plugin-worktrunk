/**
 * Frontend entry — the Worktrees panel.
 *
 * Read-only by design: the only mutation the plugin performs is
 * `wt step prune`, always behind its own `--dry-run` preview. Everything else
 * is a command you run in a terminal. See DESIGN.md.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Badge, PruneEntry, RepoFailure, WorktreeRow } from "./contract";
import { rpcContract, SNAPSHOT_CHANGED } from "./contract";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Snapshot {
  repoPath: string | null;
  defaultBranch: string | null;
  rows: WorktreeRow[];
  warnings: string[];
  failure: RepoFailure | null;
}

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
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  /**
   * A snapshot costs about a second of `wt list`. Overlapping requests would
   * queue behind each other and leave the panel permanently mid-refresh, so a
   * signal that arrives during one only schedules a single follow-up.
   */
  const inFlight = useRef(false);
  const pending = useRef(false);

  const refetch = useCallback(() => {
    if (projectId === null) return;
    if (inFlight.current) {
      pending.current = true;
      return;
    }
    inFlight.current = true;
    setLoading(true);
    const settle = () => {
      inFlight.current = false;
      setLoading(false);
      if (pending.current) {
        pending.current = false;
        refetch();
      }
    };
    rpc.call("repo_snapshot", { projectId }).then(
      (result) => {
        setSnapshot(result);
        settle();
      },
      (cause: unknown) => {
        // The RPC itself failing is still one repo's problem, not a global
        // gate: it gets the same error row with the same retry.
        setSnapshot({
          repoPath: null,
          defaultBranch: null,
          rows: [],
          warnings: [],
          failure: {
            repoPath: "",
            message: cause instanceof Error ? cause.message : String(cause),
            command: "",
          },
        });
        settle();
      },
    );
  }, [rpc, projectId]);

  useEffect(refetch, [refetch]);
  useRealtime(SNAPSHOT_CHANGED, refetch);

  return { snapshot, loading, refetch };
}

/**
 * The cross-repo count, deliberately lazy: panel open and manual refresh only.
 * The rot it hunts accrues over weeks, so a count a minute stale reads the same
 * as a live one, and a live one would cost a `wt list` per project forever.
 */
function useAttention(projectId: string | null, nonce: number) {
  const rpc = useRpc<typeof rpcContract>();
  const [summary, setSummary] = useState<{
    repos: { projectId: string; projectName: string; count: number }[];
    unreadable: string[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc
      .call("attention_summary", { excludeProjectId: projectId })
      .then((result) => {
        if (!cancelled) setSummary(result);
      }, () => undefined);
    return () => {
      cancelled = true;
    };
  }, [rpc, projectId, nonce]);

  return summary;
}

function copy(text: string, what: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(`Copied ${what}`),
    () => toast.error("Could not copy to the clipboard"),
  );
}

function CopyButton({ command, label }: { command: string; label: string }) {
  // The command is the point: hovering must show exactly what gets copied.
  return (
    <span title={command}>
      <Button size="sm" variant="ghost" onClick={() => copy(command, label)}>
        {label}
      </Button>
    </span>
  );
}

const BADGE_STYLES: Record<Badge, string> = {
  removable: "bg-muted text-muted-foreground",
  "at risk": "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  broken: "bg-destructive/15 text-destructive",
};

const BADGE_TITLES: Record<Badge, string> = {
  removable: "Integrated into the default branch — `wt step prune` would remove it.",
  "at risk": "Uncommitted changes, untouched for 14 days.",
  broken: "bb still lists this environment, but the path is no longer a worktree.",
};

function WorktreeRowView({
  row,
  repoPath,
  onOpenTerminal,
}: {
  row: WorktreeRow;
  repoPath: string | null;
  onOpenTerminal: () => void;
}) {
  const name = row.branch ?? `Detached at ${row.head?.shortSha ?? "unknown"}`;
  // bb reaps its own worktrees five minutes after the last thread is archived,
  // so offering a manual remove there invites a race with nothing to gain.
  const removable = row.ownership === "user" && !row.isMain && row.branch !== null;

  return (
    <li className="flex flex-col gap-1 border-b border-border py-2.5 text-sm last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="truncate font-medium">{name}</span>
        {row.isMain ? (
          <span className="text-xs text-muted-foreground">main checkout</span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {row.ownership === "bb" ? "bb" : "worktrunk"}
        </span>
        {row.badges.map((badge) => (
          <span
            key={badge}
            title={BADGE_TITLES[badge]}
            className={cn("rounded px-1.5 py-0.5 text-xs", BADGE_STYLES[badge])}
          >
            {badge}
          </span>
        ))}
        <span className="flex-1" />
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {row.dirty ? <span>dirty</span> : null}
          {row.conflicted ? <span>conflicted</span> : null}
          {row.ahead > 0 ? <span>↑{row.ahead}</span> : null}
          {row.behind > 0 ? <span>↓{row.behind}</span> : null}
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="truncate">{row.path}</span>
        {row.thread !== null ? (
          <span className="truncate italic">{row.thread.title}</span>
        ) : null}
        {row.devServer !== null ? (
          <span
            title={
              row.devServer.otherPorts.length === 0
                ? undefined
                : `Also listening on ${row.devServer.otherPorts.join(", ")}`
            }
          >
            :{row.devServer.port}
            {row.devServer.otherPorts.length > 0
              ? ` +${row.devServer.otherPorts.length}`
              : ""}
          </span>
        ) : null}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onOpenTerminal}>
          Terminal
        </Button>
        {/* Merge squashes, rebases, calls an LLM, and prompts for approval; it
            structurally cannot live behind a button on a single-shot RPC. */}
        {!row.isMain && row.branch !== null ? (
          <CopyButton command={`cd ${row.path} && wt merge`} label="Merge…" />
        ) : null}
        {removable && repoPath !== null ? (
          <CopyButton
            command={`wt -C ${repoPath} remove ${row.branch ?? ""}`}
            label="Remove…"
          />
        ) : null}
      </div>
    </li>
  );
}

function ErrorRow({
  failure,
  onRetry,
}: {
  failure: RepoFailure;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded border border-destructive/40 p-3 text-sm">
      <p>{failure.message}</p>
      {failure.command !== "" ? (
        <code className="block overflow-x-auto text-xs text-muted-foreground">
          {failure.command}
        </code>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
        {failure.command !== "" ? (
          <CopyButton command={failure.command} label="Copy command" />
        ) : null}
      </div>
    </div>
  );
}

function describe(entry: PruneEntry): string {
  const what =
    entry.kind === "branch_only" ? "branch" : (entry.path ?? "worktree");
  const reason = entry.reason === "" ? "" : ` — ${entry.reason}`;
  return `${entry.branch ?? what}${reason}`;
}

/**
 * The only mutation this plugin performs, and the one worktrunk command safe
 * behind a button: prune touches only branches already integrated into the
 * default branch, so it cannot eat uncommitted work. Its own `--dry-run` is
 * the confirmation list — no need to invent one.
 */
function PrunePanel({
  projectId,
  onPruned,
}: {
  projectId: string;
  onPruned: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [preview, setPreview] = useState<PruneEntry[] | null>(null);
  const [failure, setFailure] = useState<RepoFailure | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    rpc.call("prune_preview", { projectId }).then(
      (result) => {
        setBusy(false);
        if (result.status === "failed") {
          setFailure(result.failure);
          setPreview(null);
          return;
        }
        setFailure(null);
        setPreview(result.result.entries);
        for (const warning of result.result.warnings) toast.warning(warning);
      },
      (cause: unknown) => {
        setBusy(false);
        setFailure({
          repoPath: "",
          message: cause instanceof Error ? cause.message : String(cause),
          command: "",
        });
      },
    );
  }, [rpc, projectId]);

  const apply = useCallback(() => {
    setBusy(true);
    rpc.call("prune_apply", { projectId }).then(
      (result) => {
        setBusy(false);
        setPreview(null);
        if (result.status === "failed") {
          setFailure(result.failure);
          return;
        }
        toast.success(`Pruned ${result.result.entries.length} item(s).`);
        onPruned();
      },
      (cause: unknown) => {
        setBusy(false);
        setFailure({
          repoPath: "",
          message: cause instanceof Error ? cause.message : String(cause),
          command: "",
        });
      },
    );
  }, [rpc, projectId, onPruned]);

  if (failure !== null) {
    return <ErrorRow failure={failure} onRetry={load} />;
  }

  if (preview === null) {
    return (
      <Button size="sm" variant="outline" disabled={busy} onClick={load}>
        {busy ? "Checking…" : "Prune merged worktrees…"}
      </Button>
    );
  }

  if (preview.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded border border-border p-3 text-sm">
        <span className="text-muted-foreground">Nothing to prune.</span>
        <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
          Dismiss
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-border p-3 text-sm">
      <p className="font-medium">
        `wt step prune` would remove {preview.length} item(s):
      </p>
      <ul className="text-xs text-muted-foreground">
        {preview.map((entry) => (
          <li key={`${entry.kind}:${entry.branch ?? entry.path ?? ""}`}>
            {describe(entry)}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={apply}>
          {busy ? "Pruning…" : "Prune"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function AttentionLine({
  summary,
}: {
  summary: {
    repos: { projectId: string; projectName: string; count: number }[];
    unreadable: string[];
  } | null;
}) {
  const text = useMemo(() => {
    if (summary === null) return null;
    const total = summary.repos.reduce((sum, repo) => sum + repo.count, 0);
    if (total === 0) return null;
    const repos = summary.repos.length;
    return `${total} worktree${total === 1 ? "" : "s"} need attention in ${repos} other repo${repos === 1 ? "" : "s"}: ${summary.repos.map((repo) => `${repo.projectName} (${repo.count})`).join(", ")}`;
  }, [summary]);

  if (text === null) return null;
  return <p className="text-xs text-muted-foreground">{text}</p>;
}

function WorktreesPage() {
  const rpc = useRpc<typeof rpcContract>();
  const { projectId, select, projects } = useSelectedProject();
  const { snapshot, loading, refetch } = useSnapshot(projectId);
  const [attentionNonce, setAttentionNonce] = useState(0);
  const attention = useAttention(projectId, attentionNonce);

  const refreshAll = useCallback(() => {
    refetch();
    setAttentionNonce((nonce) => nonce + 1);
  }, [refetch]);

  const openTerminal = useCallback(
    (row: WorktreeRow) => {
      const label = row.branch ?? row.path;
      rpc.call("open_terminal", { path: row.path, label }).then(
        (result) => {
          // Nothing in the SDK can focus a terminal tab, so naming it is the
          // most the panel can do to help you find it.
          toast.success(`Terminal "${result.title}" opened`, {
            description: "Find it in the Terminals tab.",
          });
        },
        (cause: unknown) => {
          toast.error(
            cause instanceof Error ? cause.message : "Could not open a terminal",
          );
        },
      );
    },
    [rpc],
  );

  const rows = snapshot?.rows ?? [];

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-4 overflow-y-auto p-6">
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
        <span className="flex-1" />
        <Button size="sm" variant="ghost" disabled={loading} onClick={refreshAll}>
          {loading && snapshot === null ? "Loading…" : "Refresh"}
        </Button>
      </header>

      {snapshot?.failure != null ? (
        <ErrorRow failure={snapshot.failure} onRetry={refetch} />
      ) : null}

      {rows.length > 0 ? (
        <ul>
          {rows.map((row) => (
            <WorktreeRowView
              key={row.path}
              row={row}
              repoPath={snapshot?.repoPath ?? null}
              onOpenTerminal={() => openTerminal(row)}
            />
          ))}
        </ul>
      ) : null}

      {snapshot !== null && rows.length === 0 && snapshot.failure === null ? (
        <p className="text-sm text-muted-foreground">
          No worktrees in this repo yet. `wt switch --create &lt;branch&gt;`
          makes one.
        </p>
      ) : null}

      {projectId !== null ? (
        <PrunePanel projectId={projectId} onPruned={refreshAll} />
      ) : null}

      <AttentionLine summary={attention} />

      {snapshot !== null && snapshot.warnings.length > 0 ? (
        <ul className="text-xs text-muted-foreground">
          {snapshot.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {attention !== null && attention.unreadable.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Could not read: {attention.unreadable.join(", ")}
        </p>
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
