/**
 * What the repository tracks, held by `npm test`.
 *
 * A Finder `.DS_Store` was committed at the root, and with no `.gitignore` the
 * next one, a `node_modules/` or an agent's `.claude/worktrees/` checkout was
 * one `git add -A` away from following it into a public repository. `files`
 * in package.json keeps them out of the npm tarball; this keeps them out of
 * the tree.
 */
import "./support/home.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const IGNORED = [".DS_Store", "node_modules/", ".claude/worktrees/", "coverage/"];

function tracked() {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
      .split("\0").filter(Boolean);
  } catch {
    return null; // not a git checkout (an unpacked tarball): nothing to hold
  }
}

describe("the repository", () => {
  it("ignores the files nobody should commit", () => {
    const lines = readFileSync(join(ROOT, ".gitignore"), "utf8")
      .split(/\r?\n/).map((l) => l.trim());
    for (const pattern of IGNORED) {
      assert.ok(lines.includes(pattern), `.gitignore does not ignore ${pattern}`);
    }
  });

  it("tracks no Finder metadata", (t) => {
    const files = tracked();
    if (files === null) return t.skip("not a git checkout");
    const junk = files.filter((f) => f.split("/").pop() === ".DS_Store");
    assert.deepEqual(junk, [], `tracked: ${junk.join(", ")}`);
  });
});

describe("the workflows (ND-M13)", () => {
  const dir = join(ROOT, ".github", "workflows");
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

  it("pin every action to a commit SHA, naming the version it was", () => {
    const loose = [];
    for (const f of files) {
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        const m = /^\s*-?\s*uses:\s*(\S+)(.*)$/.exec(line);
        if (!m || m[1].startsWith("./")) continue;
        if (!/@[0-9a-f]{40}$/.test(m[1]) || !/#\s*v\d/.test(m[2])) loose.push(`${f}: ${line.trim()}`);
      }
    }
    assert.ok(files.length > 0);
    assert.deepEqual(loose, [], "an action is pinned to a movable tag");
  });

  it("grant ci.yml a read-only token and test on Windows", () => {
    const ci = readFileSync(join(dir, "ci.yml"), "utf8");
    assert.match(ci, /^permissions:\n {2}contents: read$/m);
    assert.match(ci, /os: \[[^\]]*windows-latest[^\]]*\]/);
  });
});
