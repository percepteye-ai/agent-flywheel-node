/**
 * The control plane's `/policy/current` answers, held BYTE FOR BYTE across the
 * two SDKs.
 *
 * Both SDKs ship in one release and apply the same two answers -- the gateway
 * delivery and the withdrawal -- so they are tested against ONE pair of files,
 * vendored into each repo. Equal JSON in a different order or spelling is
 * already two fixtures a reviewer has to diff by hand, and the day one SDK's
 * copy gains a field the other's lacks, each SDK is green against an answer
 * the other never sees. So the bytes are what is held equal.
 *
 * Two mechanisms, because the sibling checkout is not always there:
 *
 *   THE DIGESTS, always. They are the digests every copy was made from, so a
 *   copy edited here alone is red in this repo's own CI, where no sibling
 *   exists.
 *   THE PYTHON SDK'S COPY, whenever its checkout sits beside this one. Present
 *   means its copy must exist and match: a sibling that lacks the file is the
 *   drift this test exists to catch, not a reason to skip.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

/** Each shared fixture and the sha256 every copy of it was made from. */
const SHARED = {
  "policy_current_gateway.json":
    "8eb1fa741706b268a76db597384e5e698065e1c313e88f20a474ca067e92b191",
  "policy_current_withdrawn.json":
    "2f54007e6108e99b03d5907d7a231e66a97e334445156290880814c2e2a81511",
};

const ours = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

/**
 * The Python SDK's checkout beside this one, or null. `agent-flywheel` is what
 * a clone of the repo is called, the prefixed name what older checkouts carry
 * -- the same two names `wire.test.js` and `genai-otlp.test.js` look for.
 * Found by the repo's own marker, not by the fixture, so a checkout that is
 * there but lacks the file fails instead of passing.
 */
const pythonRoot = [
  "../../agent-flywheel/",
  "../../percepteye-agent-flywheel/",
].map((rel) => new URL(rel, import.meta.url))
  .find((root) => existsSync(new URL("pyproject.toml", root))
    && existsSync(new URL("src/agent_flywheel/", root))) ?? null;

describe("the shared /policy/current fixtures", () => {
  for (const [name, digest] of Object.entries(SHARED)) {
    it(`${name} is the shared copy, by digest`, () => {
      assert.equal(createHash("sha256").update(ours(name)).digest("hex"), digest,
        `test/fixtures/${name} is not the shared fixture -- change every copy ` +
        "together (both SDKs and the control plane), never one alone");
    });

    it(`${name} is byte-equal to the Python SDK's copy`, (t) => {
      if (!pythonRoot) {
        t.skip("no Python SDK checkout beside this one");
        return;
      }
      const theirs = new URL(`tests/fixtures/${name}`, pythonRoot);
      assert.ok(existsSync(theirs),
        `the Python SDK checkout at ${pythonRoot.pathname} has no ` +
        `tests/fixtures/${name}: the two SDKs are testing different answers`);
      assert.ok(readFileSync(theirs).equals(ours(name)),
        `test/fixtures/${name} differs from the Python SDK's copy`);
    });
  }
});
