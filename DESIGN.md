# bb-plugin-worktrunk — design

A read-only bb panel over [worktrunk](https://worktrunk.dev) (`wt`): one page showing every
worktree of the repo you're working in, what state it's in, which bb thread owns it, and which
dev server it's running.

Status: **design only.** Nothing implemented. Decisions below were settled by interview; the
rationale is recorded so they can be revisited deliberately rather than rediscovered.

## Why this exists

Worktrees are invisible past three or four of them. On this machine there are 12 non-main
worktrees across 5 repos — 5 created by bb, 6 created by worktrunk — and several are dead
without anything saying so (`sm-kb/manual-cleanup` is 188 commits behind and already merged into
main; two research worktrees are 6–7 weeks stale).

bb and worktrunk are two worktree managers operating on the same repos, unaware of each other.
bb's sidebar shows threads, not git state. `wt list` shows git state, not threads. Neither can
render the row you actually want:

> `feat/x` · ↑3 · dirty · *Keyboard integration* · dev server on :25638

That join is the whole reason to build this inside bb instead of installing
[worktrunk-deck](https://github.com/gabmichels/worktrunk-deck), which solves the same problem
standalone and from which several decisions here are borrowed outright.

## Shape

A **standalone plugin repo**, not a bundled plugin inside the bb fork. This repo is a fork of
`get-bb/bb`'s consumer, not of bb itself — every file added under bb's `plugins/` is permanent
merge surface against upstream, for code upstream has no opinion about. The plugin SDK is a
public contract precisely so this can live outside the tree.

One full-page nav panel (`app.slots.navPanel`). **Read-only**, with one exception (`wt step
prune`, below).

The read-only posture is forced as much as chosen: plugin host RPC is single-shot validated
JSON with a 30-second default timeout and no streaming or PTY. `wt merge` squashes, rebases,
calls an LLM for a commit message, and prompts for approval — it structurally cannot live behind
a button. Rather than reimplement a terminal badly, actions that mutate are pre-filled commands
the user runs in a real terminal.

## What it shows

### Scope: one repo at a time

A repo switcher in the panel header. The panel cannot ask bb which project is current — a nav
panel lives at `/plugins/<id>/<path>`, and `useBbContext()` is route-derived, so `projectId` is
`null` there. There is no `useProjects` or `useCurrentProject`, and plugins cannot write a
"last active project" UI preference (the key enum is closed).

So: persist the user's pick in `bb.storage.kv`, and seed it on first run from
`experimental_useSidebarThreads()` — take the project of the thread with the newest
`updatedAt`/`latestAttentionAt`. That costs no extra request (host-cached, realtime-updated) and
the inference runs once, where being wrong is cheap.

Rejected: deriving the project live every render (the panel would change out from under you
whenever a background thread ticks) and a `type: "project"` setting (a settings round-trip for
something you change several times a day).

Project → repo path resolves via `bb.sdk.projects.get()` → `sources`, then
`findLocalPathProjectSourceForHost(sources, hostId)`. Host comes from
`bb.sdk.system.config().primaryHostId` — there is no `isPrimary` on `Host`.

### Rows

Both populations — bb-managed worktrees under
`~/.bb/plugins/environment-git-worktree/host-data/worktrees/` and worktrunk's under
`~/worktrees/<repo>/<branch>` — **interleaved in one list**, sorted by recency.

Ownership is a badge, not a partition. It does, however, **gate the available actions**: a
bb-managed row never offers a manual remove, because bb reaps those itself five minutes after
the last thread is archived. (An earlier draft split each repo into two sub-lists for safety.
That solved a safety problem with layout; gating actions solves it directly, and `sm-app` has 6
worktrees — splitting one repo into two lists of three costs more than it protects.)

Each row: branch, path, git state from `wt list --format json`, the owning bb thread's title if
one exists, and dev-server status.

The thread join is deliberately shallow for v1 — presence and title, not live agent status.
bb's sidebar already shows agent status, so duplicating it adds a second realtime subscription
for information already on screen. Structure the row so it can drop in later.

### Badges: exactly three

The `wt` JSON offers far more signals than a row can carry. If everything is a badge, nothing
is. The filter is **actionable, not merely interesting** — "↑17" is true of every worktree here
right now and implies nothing.

- **removable** — a prune candidate. `wt list` already marks these (`_` same commit, `⊂` content
  integrated), so this is free.
- **at risk** — dirty *and* untouched for 14 days. This is the state that actually loses work,
  and nothing surfaces it today.
- **broken** — bb says the environment is `ready` but the path is no longer a git worktree.

Everything else renders as a plain column you can read but that doesn't shout.

**"Stale" means newest mtime among dirty files**, falling back to `head.committed_at` when
clean. `head.committed_at` alone is the wrong clock: a worktree whose last commit is 40 days old
but which was edited yesterday isn't forgotten, while one with a fresh commit and uncommitted
edits abandoned three weeks ago is. Computing it needs a `stat` pass in `host.ts`; worktrunk
doesn't do this for you.

**14 days, not configurable.** `wt step prune` defaults to `--min-age 1d`, so worktrunk's own
instinct is that recency is protective. 7 days fires on a normal vacation; 30 is long enough that
you've already forgotten. A threshold you can tune is one you'll tune once and never revisit, at
the cost of doubling the settings surface for a single integer.

### Cross-repo attention count

"N worktrees need attention in 2 other repos", computed **lazily** — on panel open and manual
refresh only, never in the live loop.

Live cross-repo would mean running `wt list` against all 7 projects and watching 7 `.git`
directories instead of 1: a 7× steady-state cost for a number you glance at. The rot being
hunted accumulates over weeks, so a count that's a minute stale is indistinguishable from a live
one.

### Dev servers

`lsof -nP -iTCP -sTCP:LISTEN` in `host.ts`, correlating each listener's cwd to a worktree path.

Neither existing system can answer this. worktrunk can, in principle, via `[list] url` +
`hash_port` — but there is no `[list]` section in any config here; it existed in June 2026 and
was removed. bb cannot: `bb connect expose <port>` is purely declarative (the user supplies the
number, `bb.hosts.declareSharedPorts` registers it), and nothing in bb discovers a listening
socket. There are zero bb terminals on this machine, so bb-terminal-derived visibility would be
vacuous.

`lsof` is zero-config, works today — it found both running `sm-app` servers (`:3002` in the main
checkout, `:25638` in a bb worktree) — and is the only option that sees a server started in some
random terminal three days ago, which is exactly the kind you forget. This is the one place the
deck's "worktrunk is the sole source of truth" invariant is deliberately broken, because
worktrunk doesn't have this answer.

**One row per worktree**, showing the primary port. A single Meteor worktree listens on four or
five ports (meteor-tool, mongod on port+1, a second meteor-tool, …) with the same cwd; listing
them all is noise. Optional escape hatch: a repo-supplied port command (`sm-app` already has
`bin/port.sh`), but the default must work with no config.

## Behavior

### Actions

| Action | Mechanism |
| --- | --- |
| Open terminal here | `bb.sdk.terminals.create({ kind: "host_path", hostId, cwd })` |
| Merge / remove | Pre-filled command, copyable, run by the user |
| Prune | `wt step prune`, behind a `--dry-run --format json` preview |

`wt step prune` is the single permitted mutation because it is categorically different from `wt
remove`: it only touches worktrees already integrated into the default branch, so it cannot eat
uncommitted work. It is idempotent, non-interactive, and fits a single-shot host RPC. Its native
`--dry-run --format json` provides the confirmation list — no need to invent one.

**Known gap:** nothing in the SDK focuses a terminal tab, so "open terminal here" creates a
session the user must then find. v1 shows a toast. The real fix is a small `experimental_` focus
API added to the fork's SDK — the one change here that plausibly belongs upstream.

### Freshness — three cadences

- **git state** — host-side `experimental_watch` on each repo's `.git`, re-running `wt list` on
  change, pushed via `emitSignal` → `bb.realtime.publish`. Event-driven, no idle cost. (The deck
  polls; this is strictly better.)
- **ports** — ~5s poll. An `lsof` can't be watched.
- **CI and LLM summaries** (`wt list --full`) — **never automatic.** It reaches the network and
  runs an LLM per branch. Explicit per-row action only, or you quietly spend tokens summarizing
  twelve worktrees on a timer.

### Robustness

One adapter module owns the `wt` JSON shape and **never throws** — an unexpected field degrades
one card, not the dashboard. Recorded fixtures, including a malformed one. `wt` is versioned
(`"schema": 2`) but ships fast (v0.77 today); this keeps an upgrade a one-file change.

**Per-repo error rows with retry, never a global gate.** One repo hitting git's "dubious
ownership" shouldn't kill the panel. Show the exact failing command and let the user copy it;
never auto-fix.

The `wt` binary path is a `bb.settings.define` string descriptor with a Zod
`experimental_schema`. This is the failure that will actually be hit: GUI-launched daemons
inherit a short PATH, and it was worktrunk-deck's single largest support burden. Use
`bb.status.needsConfiguration(message)` when `wt` can't be found.

**Wart:** saving a setting does not reload the plugin in V1 — the user must run `bb plugin
reload <id>`.

## Registries and truth

Two registries, joined: **worktrunk** (`wt list --format json`) and **bb** (environment rows;
`bb.sdk.projects.worktrees()` is exposed to plugins, so bb's existing worktree-discovery work is
directly consumable).

**No filesystem orphan scan.** An earlier draft argued for scanning the configured
`worktree-path` root for directories git doesn't know about, motivated by four orphaned
checkouts at `~/worktrees/worktrees/sm-app/`. Investigation showed those are a **one-time home
directory rename artifact** — `/Users/luke/worktrees` was copied into an existing
`/Users/beaver/worktrees` on 2026-07-09, producing the double nesting; their `.git` files point
at a `/Users/luke` path that no longer exists, which is exactly why git can't see them. It is
not a worktrunk bug and it cannot recur. Building a permanent code path to detect a thing that
already happened is the definition of what to cut. (Cleaned up by hand.)

Related: `git worktree prune` would currently do nothing on `sm-app` — all five admin entries
point at directories that exist. Registered-but-broken worktrees are not a live problem here.

**bb's drift is surfaced, not fixed.** Two of fifteen environments are `ready` while their paths
are no longer worktrees — user-deleted worktrees bb never noticed. The panel badges this as
*broken*; the reconciliation gap gets filed against bb core in the fork. Fixing it in a plugin
means the drift persists whenever the plugin isn't loaded.

## Explicitly out of scope

- **Agent tools and CLI commands.** The most interesting idea raised — a `worktrunk_list` tool
  would let an agent see its *siblings* ("another worktree has uncommitted changes to the file
  I'm about to refactor") — but it changes what agents *do*, not what you *see*, and needs its
  own thinking about token cost. Tool changes only take effect at the next session start anyway,
  so it isn't quick to iterate on.
- **A no-worktrunk git fallback.** bb's `project worktrees` could power a degraded view, but
  there is one machine here and `wt` is installed on it.
- **Multi-machine fan-out.** One machine. bb would make this nearly free, which is the strongest
  latent advantage over the deck — but not a problem anyone here has.
- **Configurable thresholds and rules.**
- **Thread-row badges.** Decorating bb's sidebar rows via
  `PluginContentScriptContext.experimental_setThreadRowStatus` is cheap and puts state where the
  eyes already are — but threads exist for only 5 of 12 worktrees, and badges would miss every
  stale one, which is where the pain is. Revisit after the panel.
- **Upstream contribution to worktrunk.** worktrunk ships first-party plugins for Claude Code,
  Codex, OpenCode and Pi; a `wt config plugins bb install` is a conspicuous gap and would turn
  this from CLI-scraping into a two-way contract. Deferred, not dismissed.
- **"C-lite" — delegating bb's setup to worktrunk.** Replacing `.worktreeinclude` and
  `.bb-env-setup.sh` with `wt step copy-ignored` and `wt hook post-switch` looks like welcome
  deduplication, and is not. Those files are repo-committed and portable: they work on Modal
  sandboxes and fresh machine clones where worktrunk isn't installed and there is no source
  checkout to copy from. bb would have to keep both paths regardless, so it is net *more*
  complexity for a narrower case. The duplication between bb and worktrunk is real but benign —
  two tools solving one problem for different populations.

## API anchors

Verified against `get-bb/bb` at `f820a402c`.

| Need | Symbol |
| --- | --- |
| Panel registration | `app.slots.navPanel(PluginNavPanelRegistration)` |
| Spawn `wt` on the machine | `experimental_defineHostEntry` + `experimental_spawnPortableOutputProcess` |
| app → server | `useRpc<typeof contract>().call()` / `bb.rpc.register` |
| server → host | `bb.hosts.experimental_client({ contract }).call(m, i, { hostId })` |
| host → server push | `context.experimental_emitSignal` / `host.experimental_onSignal` |
| server → app push | `bb.realtime.publish` / `useRealtime` |
| Filesystem watch | `context.experimental_watch({ rootPath, debounceMs })` |
| Poll loop | `bb.background.service(name, { start(signal) })` |
| Terminal | `bb.sdk.terminals.create({ kind: "host_path", hostId, cwd })` |
| Settings | `bb.settings.define` / `useSettings` (read-only in app) |
| Persisted pick | `bb.storage.kv` |
| Projects / host | `bb.sdk.projects.get`, `bb.sdk.system.config().primaryHostId` |
| Seed current project | `experimental_useSidebarThreads()` |

Constraint to design around: **host RPC is single-shot JSON, 30s default / 30min max, no
streaming.** Long-running work uses the job-id + progress-signal pattern from
`environment-git-worktree`, or a terminal.

## Open questions for implementation

1. Does anything here need an SDK surface that doesn't exist? The terminal-focus gap is one; a
   second would strengthen the case for building inside the fork after all.
2. What does the panel do on a repo with no worktrees beyond main — empty state, or hide?
3. Does the cross-repo count respect archived/hidden projects?
