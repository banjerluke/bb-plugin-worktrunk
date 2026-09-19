/**
 * Dev-server detection from `lsof` field output.
 *
 * Neither worktrunk nor bb can answer "what is this worktree serving": bb's
 * `expose` is declarative and worktrunk's `[list] url` section no longer
 * exists. `lsof` sees a server someone started in a terminal three days ago,
 * which is exactly the kind you forget about.
 *
 * Parsing lives here, apart from the spawn in `host.ts`, so the collapse rules
 * are testable against recorded output. Like the worktrunk adapter, nothing
 * here throws: an `lsof` that changes its field syntax yields no rows.
 */

/** A process holding a listening TCP socket. */
export interface Listener {
  pid: number;
  ppid: number;
  command: string;
  port: number;
}

/**
 * The dev server shown on a worktree row. One per worktree: a single Meteor
 * checkout listens on four or five ports (meteor-tool, mongod on port+1, a
 * second meteor-tool) from the same cwd, and listing them all is noise.
 */
export interface DevServer {
  /** The worktree path whose subtree contains the listener's cwd. */
  path: string;
  port: number;
  command: string;
  /**
   * Other durable ports from the same worktree. Ephemeral ones are dropped:
   * an editor's language server and a headless browser rebind on a new number
   * constantly, so counting them would both mean nothing and make the row look
   * like it changes every few seconds.
   */
  otherPorts: number[];
}

/**
 * macOS hands out 49152-65535 for ephemeral client sockets. A coding agent's
 * RPC port, an editor's language server, and a headless browser all land
 * there; a dev server you would type into a browser essentially never does.
 *
 * So the range is not just a tiebreak — a worktree whose *only* listeners are
 * ephemeral reports no dev server at all. Observed on a real checkout that was
 * serving nothing: `codex` on :52125 and a headless Chrome on :49444 would
 * otherwise have been announced as its dev server.
 */
const EPHEMERAL_MIN = 49152;

/** `n` looks like `127.0.0.1:3002`, `*:631`, or `[::1]:32222`. */
function portFromAddress(address: string): number | null {
  const colon = address.lastIndexOf(":");
  if (colon === -1) return null;
  const port = Number.parseInt(address.slice(colon + 1), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN -F pcRn`. Fields repeat per process: `p`
 * pid, `R` parent pid, `c` command, then one `f`/`n` pair per socket.
 */
export function parseListeners(output: string): Listener[] {
  const listeners: Listener[] = [];
  const seen = new Set<string>();
  let pid: number | null = null;
  let ppid = 0;
  let command = "";

  for (const line of output.split("\n")) {
    const field = line.slice(1);
    switch (line[0]) {
      case "p": {
        const parsed = Number.parseInt(field, 10);
        pid = Number.isInteger(parsed) ? parsed : null;
        ppid = 0;
        command = "";
        break;
      }
      case "R": {
        const parsed = Number.parseInt(field, 10);
        ppid = Number.isInteger(parsed) ? parsed : 0;
        break;
      }
      case "c":
        command = field;
        break;
      case "n": {
        const port = pid === null ? null : portFromAddress(field);
        if (pid === null || port === null) break;
        // A socket bound to both IPv4 and IPv6 is two rows, one port.
        const key = `${pid}:${port}`;
        if (seen.has(key)) break;
        seen.add(key);
        listeners.push({ pid, ppid, command, port });
        break;
      }
      default:
        break;
    }
  }
  return listeners;
}

/** Parse `lsof -a -p <pids> -d cwd -F pn` into pid -> working directory. */
export function parseCwds(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;

  for (const line of output.split("\n")) {
    const field = line.slice(1);
    if (line[0] === "p") {
      const parsed = Number.parseInt(field, 10);
      pid = Number.isInteger(parsed) ? parsed : null;
    } else if (line[0] === "n" && pid !== null && field !== "") {
      cwds.set(pid, field);
    }
  }
  return cwds;
}

/**
 * The deepest worktree whose subtree contains `cwd`. Depth matters because
 * worktrunk's default layout is a sibling suffix (`demo-app`,
 * `demo-app.feat-x`), and a plain prefix test would put every sibling's
 * listeners on the shorter path.
 */
function worktreeFor(cwd: string, paths: readonly string[]): string | null {
  let best: string | null = null;
  for (const path of paths) {
    if (cwd !== path && !cwd.startsWith(`${path}/`)) continue;
    if (best === null || path.length > best.length) best = path;
  }
  return best;
}

function isPrimary(candidate: Listener, incumbent: Listener): boolean {
  const candidateEphemeral = candidate.port >= EPHEMERAL_MIN;
  const incumbentEphemeral = incumbent.port >= EPHEMERAL_MIN;
  if (candidateEphemeral !== incumbentEphemeral) return !candidateEphemeral;
  return candidate.port < incumbent.port;
}

/**
 * Collapse every listener under a worktree into the one row a user wants.
 *
 * Meteor's extra ports all belong to processes it spawned, so a listener whose
 * parent is itself a listener in the same worktree is a child of the real
 * server and never the primary. Among what remains — which on a busy checkout
 * still includes an editor and a headless browser — the lowest non-ephemeral
 * port is the server you started.
 */
export function collapseToDevServers(
  listeners: readonly Listener[],
  cwds: ReadonlyMap<number, string>,
  worktreePaths: readonly string[],
): DevServer[] {
  const groups = new Map<string, Listener[]>();
  for (const listener of listeners) {
    const cwd = cwds.get(listener.pid);
    if (cwd === undefined) continue;
    const path = worktreeFor(cwd, worktreePaths);
    if (path === null) continue;
    const group = groups.get(path);
    if (group === undefined) groups.set(path, [listener]);
    else group.push(listener);
  }

  const servers: DevServer[] = [];
  for (const [path, group] of groups) {
    const pids = new Set(group.map((listener) => listener.pid));
    const roots = group.filter((listener) => !pids.has(listener.ppid));
    // Every process in the group descends from another: no root to prefer.
    const candidates = roots.length > 0 ? roots : group;

    let primary = candidates[0];
    if (primary === undefined) continue;
    for (const candidate of candidates) {
      if (isPrimary(candidate, primary)) primary = candidate;
    }
    if (primary.port >= EPHEMERAL_MIN) continue;

    servers.push({
      path,
      port: primary.port,
      command: primary.command,
      otherPorts: group
        .filter(
          (listener) =>
            listener.port !== primary.port && listener.port < EPHEMERAL_MIN,
        )
        .map((listener) => listener.port)
        .sort((a, b) => a - b),
    });
  }
  return servers.sort((a, b) => a.path.localeCompare(b.path));
}
