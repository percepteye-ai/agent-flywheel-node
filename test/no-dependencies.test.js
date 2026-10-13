/**
 * This plugin runs inside someone else's agent process, so it installs
 * nothing beside itself.
 *
 * A dependency here is a version conflict imposed on a customer who did not
 * ask for one. npm installs `dependencies` and `optionalDependencies`
 * outright, and npm 7+ installs `peerDependencies` too -- UNLESS
 * `peerDependenciesMeta` marks the peer optional, the one form npm never
 * installs. The OpenTelemetry API is declared exactly that way (see
 * `src/tracing.js`): already in the customer's process means spans, absent
 * means a silent no-op, and that is the same on both harnesses this package
 * supports. A peer that one harness needs and the other does not would still
 * be wrong, optional or not; that cannot be read off package.json, so it
 * stays a review question.
 *
 * ── WHY THIS IS A TEST AND NOT A WORKFLOW STEP ────────────────────────────
 *
 * It was an inline `node -e` step in ci.yml's `no-dependencies` job, which
 * forbade EVERY peer, optional ones included. So it went red from the commit
 * that declared the optional OpenTelemetry peer, while `npm test` stayed
 * green and nothing anyone ran locally said so -- and publish.yml's publish
 * job `needs` the CI workflow, so no version could be tagged at all. The same
 * lesson `oss-boundary.test.js` records: the rule lives where `npm test`
 * answers it, the CI matrix runs `npm test`, and there is no second answer
 * in CI to drift from it.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/**
 * Every dependency npm would install beside this package, as
 * `{field, name}`. Empty is the rule.
 */
function installedBeside(manifest) {
  const out = [];
  for (const field of ["dependencies", "optionalDependencies"]) {
    for (const name of Object.keys(manifest[field] ?? {})) out.push({ field, name });
  }
  for (const field of ["bundleDependencies", "bundledDependencies"]) {
    const v = manifest[field];
    const names = Array.isArray(v) ? v
      : v === true ? Object.keys(manifest.dependencies ?? {}) : [];
    for (const name of names) out.push({ field, name });
  }
  // A peer is installed unless it is EXPLICITLY optional. Absent from
  // `peerDependenciesMeta`, or `optional` anything but `true`, is installed.
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    if (manifest.peerDependenciesMeta?.[name]?.optional !== true) {
      out.push({ field: "peerDependencies", name });
    }
  }
  return out;
}

describe("the plugin installs nothing beside itself", () => {
  it("package.json declares no dependency npm would install", () => {
    assert.deepEqual(installedBeside(pkg), [],
      "a dependency here is a version conflict imposed on a customer's " +
      "process; a peer must be marked optional in peerDependenciesMeta");
  });

  it("refuses every form npm installs, and only those", () => {
    // The predicate itself, so a narrowing of it cannot pass the line above
    // by accident.
    assert.deepEqual(installedBeside({}), []);
    assert.deepEqual(installedBeside({ dependencies: { a: "1" } }),
      [{ field: "dependencies", name: "a" }]);
    assert.deepEqual(installedBeside({ optionalDependencies: { b: "1" } }),
      [{ field: "optionalDependencies", name: "b" }]);
    assert.deepEqual(installedBeside({ bundleDependencies: ["c"] }),
      [{ field: "bundleDependencies", name: "c" }]);
    assert.deepEqual(installedBeside({ peerDependencies: { d: "1" } }),
      [{ field: "peerDependencies", name: "d" }],
      "a peer with no meta is installed by npm 7+");
    assert.deepEqual(installedBeside({
      peerDependencies: { e: "1" }, peerDependenciesMeta: { e: { optional: "true" } },
    }), [{ field: "peerDependencies", name: "e" }],
    "only a literal `optional: true` keeps npm from installing it");
    assert.deepEqual(installedBeside({
      peerDependencies: { f: "1" }, peerDependenciesMeta: { f: { optional: true } },
    }), []);
  });
});
