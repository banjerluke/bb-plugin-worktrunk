import { describe, expect, it } from "vitest";
import { parseStatusPaths } from "./git-status";

// Recorded from `git status --porcelain=v1 -z` on a repo with a staged rename,
// a quote and a space in filenames, and an untracked file.
const RECORDED =
  'RM a-renamed.txt\0a.txt\0A  quo"te.txt\0A  spaced name.txt\0?? u.txt\0';

describe("parseStatusPaths", () => {
  it("reads every changed path from recorded output", () => {
    expect(parseStatusPaths(RECORDED)).toEqual([
      "a-renamed.txt",
      'quo"te.txt',
      "spaced name.txt",
      "u.txt",
    ]);
  });

  // The rename's original path is a separate record and no longer on disk;
  // treating it as a path of its own would both stat a missing file and shift
  // every later record by one.
  it("consumes a rename's original path without emitting it", () => {
    expect(parseStatusPaths("R  new.txt\0old.txt\0M  other.txt\0")).toEqual([
      "new.txt",
      "other.txt",
    ]);
  });

  it("handles a copy the same way", () => {
    expect(parseStatusPaths("C  copy.txt\0source.txt\0")).toEqual(["copy.txt"]);
  });

  it("keeps a path containing a newline intact", () => {
    expect(parseStatusPaths("?? weird\nname.txt\0")).toEqual([
      "weird\nname.txt",
    ]);
  });

  it.each([
    ["empty output", ""],
    ["a lone terminator", "\0"],
    ["a truncated record", "M\0"],
    ["a record missing its separator space", "MMnospace.txt\0"],
  ])("yields nothing for %s", (_label, input) => {
    expect(parseStatusPaths(input)).toEqual([]);
  });
});
