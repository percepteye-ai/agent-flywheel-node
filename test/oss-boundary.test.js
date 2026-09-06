/**
 * The open-source boundary, enforced — as a TEST, not as CI YAML.
 *
 * This package installs into other people's production processes, and this
 * repo is meant to be readable by them one day — it is PRIVATE today (verified
 * 2026-09-06: github.com/percepteye-ai/agent-flywheel-node 404s anonymously),
 * and nothing here may assume otherwise. Two properties have to hold
 * mechanically:
 *
 *   1. Nothing internal leaks. Not a private control-plane module path, not an
 *      internal field name, not a developer's home directory. A customer can
 *      act on none of them, so naming one only discloses.
 *   2. The documentation assets never ship. `docs/assets` is 4 MB of animated
 *      GIFs for the README and GitHub; a customer who runs `npm install` is
 *      not asking for them.
 *
 * ── WHY THIS IS A TEST AND NOT A WORKFLOW STEP ────────────────────────────
 *
 * It was a workflow step: a `git grep` job called `oss-boundary` in `ci.yml`,
 * added as "the producer for that consumer" after an internal module path was
 * found in a tracked test file. The strings were never removed. So the job was
 * RED from the commit that introduced it — its own comment says a permanently
 * failing gate is how a gate gets muted — while `npm test` was green, because
 * the rule lived nowhere the suite could see it.
 *
 * The sibling Python package enforces the identical rule as a test over every
 * git-tracked file, and that one has never been red. Same rule, same place:
 * `npm test` now answers this question, and there is no second answer in CI to
 * drift from it.
 *
 * ── THE WORD LISTS ────────────────────────────────────────────────────────
 *
 * Deliberately the SAME lists as the Python package's `tests/
 * test_oss_boundary.py`, term for term. The workflow step forbade nine fewer
 * terms than the test it called itself the counterpart of, and a guard that is
 * quietly narrower than the one it claims to mirror is worse than no guard: it
 * reads as coverage. `scored_suite_sha` and `prompt_group_key` are exactly the
 * kind of term that arrives in a comment explaining a wire contract, which is
 * how three of them once reached a published schema description.
 *
 * ── SCANNED AS BYTES, DECODED STRICTLY ────────────────────────────────────
 *
 * A binary asset carries no text and is skipped, rather than decoded
 * leniently. Lenient decoding is worse than useless in both directions: it
 * cannot find a name rendered into a figure, because that is pixels, and it
 * INVENTS names, because dropping invalid bytes welds whatever survives into
 * new words. A re-render of `flywheel-loop.gif` in the Python repo produced a
 * file whose bytes contain no forbidden term anywhere but which decoded
 * leniently to a string carrying one. The figures are regenerated whenever
 * their renderer changes, so every render was another roll of that dice.
 *
 * This file is exempt from the scan: it has to name the internals in order to
 * forbid them.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), "..");

/** Names of internal systems. None may appear anywhere in a published file. */
const INTERNAL_NAMES = [
  "agent_protocol", "mission_control", "missioncontrol",
  "ranger", "compass", "scout", "litesim", "litesimulation",
  "ftagent", "scoutagent", "percepteye-platform",
];

/** Internal invariants a customer can act on none of, so naming them discloses. */
const INTERNAL_DETAILS = [
  "max-loras", "vllm", "offline_grpo", "bundle_materializer",
  "scored_suite_sha", "prompt_group_key", "doctrine",
];

/** Extensions that are documentation assets, never package payload. */
const ASSET_EXTENSIONS = [
  ".gif", ".png", ".jpg", ".jpeg", ".svg", ".webp", ".mp4", ".mov", ".webm",
];

/**
 * Every file git tracks, which is exactly what a reader of the repo sees once
 * it opens. Not `src/`: the README, the schema and the tests travel as far as
 * the package does, so they are scanned the same way.
 */
function publishedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  const paths = out.split("\0").filter(Boolean).filter((p) => !HERE.endsWith(p));
  assert.ok(paths.length, "git ls-files returned nothing — this scan would pass vacuously");
  return paths;
}

/** The lowercased text of a published file, or "" for one that carries none. */
function textOf(relPath) {
  const bytes = readFileSync(resolve(ROOT, relPath));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).toLowerCase();
  } catch {
    return ""; // a binary asset carries no text
  }
}

/** What `npm publish` would actually put on a customer's disk. */
function packedFiles() {
  let raw;
  try {
    raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    assert.fail(
      "`npm pack --dry-run --json` did not run, so what this package ships " +
      `is unchecked: ${err?.message ?? err}`);
  }
  const files = JSON.parse(raw)?.[0]?.files ?? [];
  assert.ok(files.length, "npm pack listed no files — this check would pass vacuously");
  return files.map((f) => f.path);
}

describe("the open-source boundary", () => {
  it("names no internal system in any published file", () => {
    const offenders = [];
    for (const rel of publishedFiles()) {
      const text = textOf(rel);
      if (!text) continue;
      for (const name of INTERNAL_NAMES) {
        const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
        for (const m of text.matchAll(re)) {
          const line = text.slice(0, m.index).split("\n").length;
          offenders.push(`${rel}:${line} -> ${name}`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      `internal names leaked into PUBLISHED files:\n${offenders.join("\n")}`);
  });

  it("discloses no internal invariant in any published file", () => {
    const offenders = [];
    for (const rel of publishedFiles()) {
      const text = textOf(rel);
      if (!text) continue;
      for (const name of INTERNAL_DETAILS) {
        if (text.includes(name)) offenders.push(`${rel} -> ${name}`);
      }
    }
    assert.deepEqual(offenders, [],
      `internal detail disclosed in PUBLISHED files:\n${offenders.join("\n")}`);
  });

  it("publishes no local developer path", () => {
    // An absolute path off a developer's machine discloses the username, the
    // internal repo names and the working layout, and it cannot work for
    // anyone else. One shipped publicly for exactly this reason.
    const pattern = /(\/users\/[^/\s"']+\/|\/home\/[^/\s"']+\/|c:\\users\\)/g;
    const offenders = [];
    for (const rel of publishedFiles()) {
      const text = textOf(rel);
      if (!text) continue;
      for (const m of text.matchAll(pattern)) offenders.push(`${rel} -> ${m[0]}`);
    }
    assert.deepEqual(offenders, [],
      `a local developer path is published:\n${offenders.join("\n")}`);
  });

  it("ships no documentation asset in the npm package", () => {
    // The GIFs are for the README and for GitHub. `files` in package.json is
    // an allowlist that excludes `docs/`, which is why this holds today -- and
    // a sentence in docs/assets/README.md saying so is not a mechanism. The
    // question is what the TARBALL contains, so that is what is asked.
    const shipped = packedFiles();
    const assets = shipped.filter(
      (p) => ASSET_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(ext))
        || p.startsWith("docs/"),
    );
    assert.deepEqual(assets, [],
      `documentation assets must never reach a customer's disk:\n${assets.join("\n")}`);
  });

  it("names every README image relatively, so it renders on GitHub", () => {
    // THE OTHER HALF OF THE TEST ABOVE, AND THE TRADE-OFF IT SETTLES.
    //
    // `files` ships README.md and excludes `docs/`, so a relative
    // `<img src="docs/assets/...">` points at a path deliberately absent from
    // the tarball, and on a registry page that image is broken. The fix for
    // THAT is an absolute https://raw.githubusercontent.com/... URL, it was
    // applied here, and it broke all three figures on github.com -- the page
    // the GIFs exist for. raw.githubusercontent.com serves a PRIVATE repo's
    // file to nobody unauthenticated, so those URLs 404 for every reader, the
    // owner included. Verified 2026-09-06: all three returned HTTP 404, as did
    // the repo page itself. This had already been reported once and fixed by
    // moving to relative paths; the absolute pass reintroduced it.
    //
    // So: GitHub is the target surface while this repo is private and neither
    // package is published, and relative wins. ON PUBLISH the two halves flip
    // TOGETHER -- absolute raw URLs only resolve once the repo is public, and
    // only then does a registry page have a reader. Never flip one alone.
    //
    // Asserted both ways, because a relative path that is wrong is as broken
    // as an absolute one: every <img> src must be relative AND must name a
    // file that exists. Shields badges are markdown `![](https://...)` rather
    // than <img> tags, so they are out of scope and correctly absolute.
    const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
    const sources = [...readme.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(sources.length,
      "no <img> found in the README -- this check would pass vacuously");

    const absolute = sources.filter((src) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(src));
    assert.deepEqual(absolute, [],
      "a README image must be a relative path -- an absolute raw.githubusercontent " +
      `URL 404s for every reader while this repo is private:\n${absolute.join("\n")}`);

    const missing = sources.filter((src) => !existsSync(resolve(ROOT, src.split(/[?#]/)[0])));
    assert.deepEqual(missing, [],
      `a README image names a file that is not in the repo:\n${missing.join("\n")}`);
  });
});
