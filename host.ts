/**
 * Host entry: the only place `wt` is spawned.
 *
 * Runs on the enrolled machine under the host daemon, which inherits a short
 * PATH — so an explicit binary path from settings always wins over `wt`.
 */
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostContract, hostSignals } from "./contract";
import { adaptListOutput } from "./lib/adapter";

const run = promisify(execFile);

/** Only these subcommands may ever be spawned. Widening this is a security decision. */
const ALLOWED = ["list", "step"] as const;

const DEFAULT_BINARY = "wt";
const TIMEOUT_MS = 20_000;
const MAX_BUFFER = 8 * 1024 * 1024;

function binary(binaryPath: string | null): string {
  return binaryPath === null || binaryPath.trim() === ""
    ? DEFAULT_BINARY
    : binaryPath;
}

function formatCommand(bin: string, args: string[]): string {
  return [bin, ...args].join(" ");
}

async function wt(
  binaryPath: string | null,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  const [subcommand] = args.filter((arg) => !arg.startsWith("-"));
  if (subcommand === undefined || !ALLOWED.includes(subcommand as never)) {
    throw new Error(`Refusing to run \`wt ${subcommand ?? ""}\`.`);
  }
  const { stdout } = await run(binary(binaryPath), args, {
    signal,
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    // The daemon's environment is already sanitized; do not inherit a shell.
    shell: false,
  });
  return stdout;
}

export function createWorktrunkHostEntry() {
  return experimental_defineHostEntry({
    contract: hostContract,
    experimental_signals: hostSignals,
    handlers: {
      async probe({ binaryPath }, context) {
        const bin = binary(binaryPath);
        try {
          const { stdout } = await run(bin, ["--version"], {
            signal: context.signal,
            timeout: TIMEOUT_MS,
          });
          return {
            status: "ok",
            resolvedPath: bin,
            version: stdout.trim(),
          } as const;
        } catch (error) {
          return {
            status: "missing",
            message:
              error instanceof Error
                ? error.message
                : `Could not run \`${bin} --version\`.`,
          } as const;
        }
      },

      async list({ repoPath, binaryPath }, context) {
        const args = ["-C", repoPath, "list", "--format", "json"];
        try {
          const stdout = await wt(binaryPath, args, context.signal);
          return {
            status: "ok",
            snapshot: adaptListOutput(JSON.parse(stdout), repoPath),
          } as const;
        } catch (error) {
          return {
            status: "failed",
            failure: {
              repoPath,
              message: error instanceof Error ? error.message : String(error),
              command: formatCommand(binary(binaryPath), args),
            },
          } as const;
        }
      },

      async prunePreview({ repoPath, binaryPath }, context) {
        const args = [
          "-C",
          repoPath,
          "step",
          "prune",
          "--dry-run",
          "--format",
          "json",
        ];
        const raw = await wt(binaryPath, args, context.signal);
        // TODO: parse once a real prune-candidate fixture exists; the shape is
        // unverified, so the raw text is what the confirmation renders today.
        return { paths: [], raw };
      },
    },
  });
}

export default createWorktrunkHostEntry();
