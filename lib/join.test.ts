import { describe, expect, it } from "vitest";
import type { BbWorktree, JoinInput, ThreadRef } from "./join";
import { joinRows } from "./join";
import type { Worktree } from "./types";

const NOW = Date.parse("2026-09-18T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

function worktree(overrides: Partial<Worktree> & { path: string }): Worktree {
  return {
    branch: "feat/x",
    isMain: false,
    isCurrent: false,
    detached: false,
    head: null,
    dirty: false,
    conflicted: false,
    ahead: 0,
    behind: 0,
    pruneCandidate: false,
    ownership: "user",
    lastTouchedAt: daysAgo(1),
    ...overrides,
  };
}

function bb(overrides: Partial<BbWorktree> & { path: string }): BbWorktree {
  return {
    branch: "feat/x",
    environmentId: "env_1",
    ownership: "bb",
    available: true,
    ...overrides,
  };
}

function thread(overrides: Partial<ThreadRef> & { id: string }): ThreadRef {
  return {
    title: "Some thread",
    environmentId: "env_1",
    environmentPath: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function join(overrides: Partial<JoinInput> = {}) {
  return joinRows({
    worktrees: [],
    bbWorktrees: [],
    threads: [],
    servers: [],
    now: NOW,
    ...overrides,
  });
}

describe("joinRows", () => {
  it("attaches a thread title through bb's environment id", () => {
    const rows = join({
      worktrees: [worktree({ path: "/w" })],
      bbWorktrees: [bb({ path: "/w", environmentId: "env_1", ownership: "bb" })],
      threads: [thread({ id: "thr_1", title: "Keyboard integration" })],
    });
    expect(rows[0]?.thread).toEqual({ id: "thr_1", title: "Keyboard integration" });
    expect(rows[0]?.environmentId).toBe("env_1");
  });

  it("falls back to the thread's own environment path", () => {
    const rows = join({
      worktrees: [worktree({ path: "/w" })],
      threads: [
        thread({ id: "thr_1", environmentId: null, environmentPath: "/w/" }),
      ],
    });
    expect(rows[0]?.thread?.id).toBe("thr_1");
  });

  // A worktree outlives the threads that used it. Naming the stalest one would
  // be worse than naming none.
  it("prefers the most recently updated thread for an environment", () => {
    const rows = join({
      worktrees: [worktree({ path: "/w" })],
      bbWorktrees: [bb({ path: "/w", ownership: "bb" })],
      threads: [
        thread({ id: "old", title: "Old", updatedAt: NOW - 5 * DAY }),
        thread({ id: "new", title: "New", updatedAt: NOW }),
      ],
    });
    expect(rows[0]?.thread?.id).toBe("new");
  });

  it("leaves thread null when nothing owns the worktree", () => {
    const rows = join({ worktrees: [worktree({ path: "/w" })] });
    expect(rows[0]?.thread).toBeNull();
  });

  it("attaches the dev server on a matching path", () => {
    const rows = join({
      worktrees: [worktree({ path: "/w" })],
      servers: [{ path: "/w", port: 3002, command: "node", otherPorts: [3003] }],
    });
    expect(rows[0]?.devServer).toEqual({ port: 3002, otherPorts: [3003] });
  });

  it("does not put one worktree's server on another", () => {
    const rows = join({
      worktrees: [worktree({ path: "/a" }), worktree({ path: "/b" })],
      servers: [{ path: "/a", port: 3002, command: "node", otherPorts: [] }],
    });
    expect(rows.find((row) => row.path === "/b")?.devServer).toBeNull();
  });

  // The only way the broken badge can fire: git has forgotten the directory,
  // so `wt list` cannot report it and bb's registry is the sole witness.
  it("synthesizes a row for a bb environment whose path is gone", () => {
    const rows = join({
      worktrees: [worktree({ path: "/live" })],
      bbWorktrees: [
        bb({ path: "/live", environmentId: "env_1", ownership: "bb" }),
        bb({
          path: "/gone",
          branch: "feat/gone",
          environmentId: "env_2",
          ownership: "bb",
          available: false,
        }),
      ],
    });
    const broken = rows.find((row) => row.path === "/gone");
    expect(broken?.badges).toEqual(["broken"]);
    // bb remembers the branch even though the directory is gone; a row
    // labelled "Detached at unknown" would name nothing the user recognizes.
    expect(broken?.branch).toBe("feat/gone");
    expect(broken?.environmentId).toBe("env_2");
  });

  // When `wt` cannot be run at all, bb's registry is the only thing left; a
  // blank panel beside the error row would be worse than a partial one.
  it("falls back to bb's registry when worktrunk reported nothing", () => {
    const rows = join({
      worktrees: [],
      bbWorktrees: [bb({ path: "/w", branch: "feat/live", ownership: "bb" })],
    });
    expect(rows.map((row) => row.branch)).toEqual(["feat/live"]);
    expect(rows[0]?.badges).toEqual([]);
  });

  it("does not duplicate a worktree bb and worktrunk both report", () => {
    const rows = join({
      worktrees: [worktree({ path: "/w" })],
      bbWorktrees: [bb({ path: "/w", ownership: "bb" })],
    });
    expect(rows).toHaveLength(1);
  });

  it("lets bb's ownership override the adapter's path heuristic", () => {
    const rows = join({
      worktrees: [worktree({ path: "/somewhere/odd", ownership: "user" })],
      bbWorktrees: [bb({ path: "/somewhere/odd", ownership: "bb" })],
    });
    expect(rows[0]?.ownership).toBe("bb");
  });

  it("keeps worktrunk's ownership for a worktree bb never saw", () => {
    const rows = join({ worktrees: [worktree({ path: "/w", ownership: "user" })] });
    expect(rows[0]?.ownership).toBe("user");
  });

  it("computes badges from the joined availability", () => {
    const rows = join({
      worktrees: [
        worktree({ path: "/w", dirty: true, lastTouchedAt: daysAgo(30) }),
      ],
    });
    expect(rows[0]?.badges).toEqual(["at risk"]);
  });

  it("pins the main checkout above more recent worktrees", () => {
    const rows = join({
      worktrees: [
        worktree({ path: "/fresh", lastTouchedAt: daysAgo(0) }),
        worktree({ path: "/main", isMain: true, lastTouchedAt: daysAgo(40) }),
      ],
    });
    expect(rows.map((row) => row.path)).toEqual(["/main", "/fresh"]);
  });

  it("orders the rest by recency, oldest last", () => {
    const rows = join({
      worktrees: [
        worktree({ path: "/old", lastTouchedAt: daysAgo(40) }),
        worktree({ path: "/new", lastTouchedAt: daysAgo(1) }),
        worktree({ path: "/unknown", lastTouchedAt: null }),
      ],
    });
    expect(rows.map((row) => row.path)).toEqual(["/new", "/old", "/unknown"]);
  });

  it("matches paths that differ only by a trailing slash", () => {
    const rows = join({
      worktrees: [worktree({ path: "/w" })],
      bbWorktrees: [bb({ path: "/w/", environmentId: "env_9", ownership: "bb" })],
      servers: [{ path: "/w/", port: 4000, command: "node", otherPorts: [] }],
    });
    expect(rows[0]?.environmentId).toBe("env_9");
    expect(rows[0]?.devServer?.port).toBe(4000);
  });
});
