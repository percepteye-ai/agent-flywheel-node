/**
 * Where the Python SDK's checkout is, or null. ONE definition.
 *
 * Four suites compare this package with the Python authority -- the vendored
 * schema, the shared fixtures, the capture golden and the evidence
 * vocabulary -- and each carried its own copy of "look two directories up for
 * one of two names". That finds a sibling clone and nothing else: in a
 * worktree, or in CI, the checkout beside this one is a different commit or
 * is not there, so the comparison either ran against the wrong tree or
 * skipped while looking green.
 *
 * THE RULE, the same one the Python suite applies to this package
 * (`tests/node_sdk.py`):
 *
 *  - AUTO-DISCOVERY MAY FIND NOTHING. A developer who checked out only this
 *    repo has no Python SDK to compare with; `null`, and the caller skips.
 *  - AN EXPLICIT `PERCEPTEYE_PYTHON_SDK` IS A PROMISE. Somebody said the
 *    checkout is there. If it is not one, this throws and the test fails.
 *
 * A checkout is recognised by the repo's own marker (`pyproject.toml` and
 * `src/agent_flywheel/`), never by the file a caller is about to compare, so
 * a checkout that is there but lacks the file fails instead of passing.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const isCheckout = (root) => existsSync(new URL("pyproject.toml", root))
  && existsSync(new URL("src/agent_flywheel/", root));

function find() {
  const named = process.env.PERCEPTEYE_PYTHON_SDK;
  if (named) {
    const root = pathToFileURL(`${resolve(named)}/`);
    if (!isCheckout(root)) {
      throw new Error(
        `PERCEPTEYE_PYTHON_SDK names ${named}, which is not a checkout of ` +
        `the Python SDK (no pyproject.toml and src/agent_flywheel/ there)`);
    }
    return root;
  }
  // `agent-flywheel` is what a clone of the repo is called, the prefixed
  // name what older checkouts carry.
  return ["../../../agent-flywheel/", "../../../percepteye-agent-flywheel/"]
    .map((rel) => new URL(rel, import.meta.url))
    .find(isCheckout) ?? null;
}

/** The checkout's root as a directory URL, or null when none was found. */
export const pythonRoot = find();

/** `relative` inside the Python checkout, or null when there is no checkout. */
export function pythonFile(relative) {
  return pythonRoot ? new URL(relative, pythonRoot) : null;
}
