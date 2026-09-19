# bb-plugin-worktrunk

A read-only [bb](https://getbb.app) panel over [worktrunk](https://worktrunk.dev) (`wt`).

One page showing every worktree of the repo you're working in: its git state, the bb thread that
owns it, and the dev server it's running. worktrunk stays the source of truth for worktree state;
this renders the answer and gets out of the way.

**Status: scaffold.** The structure, contracts, and adapter are in place. The panel renders rows
from real `wt list` output; badges, dev-server detection, the bb thread join, and prune are not
implemented yet. See [DESIGN.md](./DESIGN.md) for the full design and the reasoning behind it.

## Requirements

- [worktrunk](https://worktrunk.dev) on the machine bb runs on. GUI-launched daemons inherit a
  short `PATH`, so if `wt` isn't found, set its absolute path in the plugin's settings.
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
host.ts            the ONLY place `wt` is spawned; runs on the enrolled machine
server.ts          settings, host client, panel RPC
app.tsx            the Worktrees panel
lib/adapter.ts     the ONLY place that reads worktrunk's JSON shape
lib/types.ts       the types the UI renders
test/fixtures/     recorded `wt list` output, sanitized
```

Two rules carried over from [worktrunk-deck](https://github.com/gabmichels/worktrunk-deck), whose
design informed this one:

1. **worktrunk's JSON shape is known in exactly one file.** Nothing outside `lib/adapter.ts` reads
   a raw worktrunk field, so a `wt` upgrade is a one-file change.
2. **The adapter never throws.** worktrunk ships on its own cadence; an unexpected payload must
   degrade one row, not blank the panel. The malformed-input cases in `lib/adapter.test.ts`
   enforce this — extend them rather than loosening them.

Fixtures are sanitized to `example-user` / `demo-app`. No real paths, usernames, or private repo
names.
