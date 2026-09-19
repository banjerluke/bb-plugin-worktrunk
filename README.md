# bb-plugin-worktrunk

A read-only [bb](https://getbb.app) panel over [worktrunk](https://worktrunk.dev) (`wt`).

One page showing every worktree of the repo you're working in: its git state, the bb thread that
owns it, and the dev server it's running. worktrunk stays the source of truth for worktree state;
this renders the answer and gets out of the way.

**Status: v1.** Rows, the three badges, the bb thread join, dev-server detection, prune, and the
cross-repo attention count all work against real data. See [DESIGN.md](./DESIGN.md) for the full
design and the reasoning behind it.

## Requirements

- [worktrunk](https://worktrunk.dev) on the machine bb runs on. GUI-launched daemons inherit a
  short `PATH`, so if `wt` isn't found, set its absolute path in the plugin's settings and run
  `bb plugin reload worktrunk` — saving a setting does not reload a plugin.
- `git` and `lsof`, for the staleness and dev-server passes. Both ship with macOS.
- bb >= 0.43.

## Develop

```sh
npm install --include=dev
npm run typecheck
npm test
bb plugin install .     # register this directory in place
bb plugin dev           # rebuild + reload on every save
```

### The vendored SDK

`@get-bb/plugin-sdk` is pinned to a **local tarball** under `vendor/`, which is gitignored. The
SDK version matching a given bb build is not always published to npm, so regenerate it from a bb
checkout at the matching version:

```sh
cd <bb-repo>/packages/plugin-sdk
pnpm exec turbo run build:types --filter=@get-bb/plugin-sdk   # bundled-types/ is generated
npm pack --pack-destination <this-repo>/vendor
```

Then point the devDependency at the tarball it wrote. Run `bb plugin types` once the version
publishes to npm, and drop the tarball.

## Layout

```
contract.ts        wire contracts: server <-> host, panel <-> server
host.ts            the ONLY place a subprocess is spawned; runs on the enrolled machine
server.ts          settings, host client, the joins, panel RPC, refresh loops
app.tsx            the Worktrees panel
lib/adapter.ts     the ONLY place that reads `wt list` JSON
lib/prune.ts       the ONLY place that reads `wt step prune` JSON
lib/git-status.ts  `git status --porcelain -z` paths, for the staleness pass
lib/ports.ts       `lsof` parsing and the one-port-per-worktree collapse
lib/badges.ts      the three badge rules
lib/join.ts        worktrunk + bb registry + dev server -> one row per worktree
lib/types.ts       the types the UI renders
test/fixtures/     recorded `wt` and `lsof` output, sanitized
```

Two rules carried over from [worktrunk-deck](https://github.com/gabmichels/worktrunk-deck), whose
design informed this one:

1. **worktrunk's JSON shape is known in exactly one file per command.** Nothing outside
   `lib/adapter.ts` reads a raw `wt list` field and nothing outside `lib/prune.ts` reads a raw
   `wt step prune` field, so a `wt` upgrade is a one-file change.
2. **Those adapters never throw.** worktrunk ships on its own cadence; an unexpected payload must
   degrade one row, not blank the panel. The malformed-input cases in `lib/adapter.test.ts` and
   `lib/prune.test.ts` enforce this — extend them rather than loosening them.

`lsof` is the one place the "worktrunk is the sole source of truth" rule is broken on purpose,
because worktrunk does not know what a worktree is serving. `lib/ports.ts` is held to the same
never-throw standard.

Fixtures are sanitized to `example-user` / `demo-app`. No real paths, usernames, or private repo
names.
