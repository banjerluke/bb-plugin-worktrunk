import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collapseToDevServers, parseCwds, parseListeners } from "./ports";

function fixture(name: string): string {
  return readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8");
}

const listeners = parseListeners(fixture("lsof-listeners.txt"));
const cwds = parseCwds(fixture("lsof-cwds.txt"));

const MAIN = "/Users/example-user/Code/demo-app";
const BB_WORKTREE =
  "/Users/example-user/.bb/plugins/environment-git-worktree/host-data/worktrees/thr_example-1/demo-app";

describe("parseListeners", () => {
  it("reads pid, parent, command, and port from field output", () => {
    expect(listeners).toContainEqual({
      pid: 15776,
      ppid: 13282,
      command: "node",
      port: 3002,
    });
  });

  it("keeps a process's second socket on a different port", () => {
    const ports = listeners
      .filter((listener) => listener.pid === 66508)
      .map((listener) => listener.port);
    expect(ports).toEqual([64356, 26743]);
  });

  it("collapses a dual-stack bind to one listener", () => {
    expect(listeners.filter((listener) => listener.pid === 90001)).toHaveLength(1);
  });

  it.each([
    ["empty output", ""],
    ["prose instead of fields", "lsof: no such user\nusage: ..."],
    ["a socket before any pid", "n127.0.0.1:3000"],
    ["an unparseable address", "p1\nR1\ccat\nnnot-an-address"],
  ])("yields nothing for %s", (_label, input) => {
    expect(parseListeners(input)).toEqual([]);
  });
});

describe("parseCwds", () => {
  it("maps pids to working directories", () => {
    expect(cwds.get(15776)).toBe(MAIN);
  });

  it.each([
    ["empty output", ""],
    ["a path before any pid", "n/tmp"],
  ])("yields nothing for %s", (_label, input) => {
    expect(parseCwds(input).size).toBe(0);
  });
});

describe("collapseToDevServers", () => {
  const servers = collapseToDevServers(listeners, cwds, [MAIN, BB_WORKTREE]);

  it("reports one row per worktree", () => {
    expect(servers.map((server) => server.path)).toEqual([BB_WORKTREE, MAIN]);
  });

  // The regression this exists for: Meteor's mongod and second bundler both
  // listen from the checkout, and only the port you type in a browser matters.
  it("picks the meteor port over mongod and the spawned bundler", () => {
    const main = servers.find((server) => server.path === MAIN);
    expect(main?.port).toBe(3002);
    expect(main?.otherPorts).toEqual([3003, 26743]);
  });

  it("finds the server in a bb-managed worktree", () => {
    const worktree = servers.find((server) => server.path === BB_WORKTREE);
    expect(worktree?.port).toBe(25638);
    expect(worktree?.command).toBe("node");
  });

  it("attributes a nested cwd to the worktree above it", () => {
    // mongod runs from .meteor/local/db, not the worktree root.
    const worktree = servers.find((server) => server.path === BB_WORKTREE);
    expect(worktree?.otherPorts).toContain(25639);
  });

  it("ignores listeners whose cwd is outside every worktree", () => {
    const ports = servers.flatMap((server) => [server.port, ...server.otherPorts]);
    expect(ports).not.toContain(3773);
    expect(ports).not.toContain(22);
  });

  it("prefers a non-ephemeral port over a numerically lower ephemeral one", () => {
    const servers = collapseToDevServers(
      [
        { pid: 10, ppid: 1, command: "node", port: 50001 },
        { pid: 11, ppid: 1, command: "vite", port: 5173 },
      ],
      new Map([
        [10, "/w"],
        [11, "/w"],
      ]),
      ["/w"],
    );
    expect(servers[0]?.port).toBe(5173);
  });

  it("drops ephemeral ports rather than counting an editor as a dev server", () => {
    const main = servers.find((server) => server.path === MAIN);
    // The headless browser on :54592 and codex on :64772 are in the group.
    expect(main?.otherPorts).not.toContain(54592);
  });

  // A coding agent and a headless browser both listen from a checkout that is
  // serving nothing. Announcing either as "the dev server" is worse than
  // saying nothing.
  it("reports no server when every listener is on an ephemeral port", () => {
    const servers = collapseToDevServers(
      [
        { pid: 10, ppid: 1, command: "codex", port: 52125 },
        { pid: 11, ppid: 1, command: "chrome", port: 49444 },
      ],
      new Map([
        [10, "/w"],
        [11, "/w"],
      ]),
      ["/w"],
    );
    expect(servers).toEqual([]);
  });

  it("does not spill a sibling worktree's ports onto the shorter path", () => {
    const servers = collapseToDevServers(
      [{ pid: 10, ppid: 1, command: "node", port: 3100 }],
      new Map([[10, "/repos/demo-app.feat-x/src"]]),
      ["/repos/demo-app", "/repos/demo-app.feat-x"],
    );
    expect(servers).toEqual([
      {
        path: "/repos/demo-app.feat-x",
        port: 3100,
        command: "node",
        otherPorts: [],
      },
    ]);
  });

  it("still reports a port when every process descends from another", () => {
    const servers = collapseToDevServers(
      [
        { pid: 10, ppid: 11, command: "a", port: 4000 },
        { pid: 11, ppid: 10, command: "b", port: 4001 },
      ],
      new Map([
        [10, "/w"],
        [11, "/w"],
      ]),
      ["/w"],
    );
    expect(servers[0]?.port).toBe(4000);
  });
});
