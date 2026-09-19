/**
 * `git status --porcelain -z` path extraction, for the "at risk" mtime pass.
 *
 * worktrunk reports *that* a worktree is dirty, never *when* it was last
 * edited, and `head.committed_at` is the wrong clock for that question. The
 * newest mtime among dirty files is the right one, and getting it needs the
 * file names.
 *
 * `-z` is what makes this safe: paths are NUL-terminated and never quoted, so
 * a filename containing a space, a newline, or a quote parses like any other.
 */

/** A rename or copy entry carries two paths: the new one, then the original. */
const RENAME_STATUSES = new Set(["R", "C"]);

/**
 * Extract the working-tree paths from `git status --porcelain=v1 -z` output.
 * Paths are repo-relative. Never throws; a record it cannot read is skipped.
 */
export function parseStatusPaths(output: string): string[] {
  const records = output.split("\0");
  const paths: string[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) continue;
    // "XY path": two status letters and a space.
    if (record[2] !== " ") continue;

    paths.push(record.slice(3));
    // The original path of a rename follows as its own record and is gone from
    // disk, so consume it without stat'ing it.
    const staged = record[0] ?? "";
    const unstaged = record[1] ?? "";
    if (RENAME_STATUSES.has(staged) || RENAME_STATUSES.has(unstaged)) {
      index += 1;
    }
  }
  return paths;
}
