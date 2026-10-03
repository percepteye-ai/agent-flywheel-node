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
 * Two mechanisms in ONE test per fixture, because the sibling checkout is not
 * always there:
 *
 *   THE DIGESTS, always. They are the digests every copy was made from, so a
 *   copy edited here alone is red in this repo's own CI, where no sibling
 *   exists.
 *   THE PYTHON SDK'S COPY, whenever its checkout sits beside this one. Present
 *   means its copy must exist and match: a sibling that lacks the file is the
 *   drift this test exists to catch, not a reason to skip.
 *
 * NOT a test of its own that skips without the sibling: that was a visible
 * skip in every standalone checkout and in CI, against a suite that publishes
 * "0 skips", and the Python SDK folded its own sibling comparison into its
 * digest test for the same reason. `wire.test.js` and `genai-otlp.test.js`
 * compare against the sibling the same way, inside the test that always runs.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

/** Each shared fixture and the sha256 every copy of it was made from. */
const SHARED = {
  "policy_current_gateway.json":
    "46871a1b96401e321df5a19501f0bbcaa0413970ad1629be56cc276d25a0a3a6",
  "policy_current_withdrawn.json":
    "b370a3ae9b5742b78d6b97c5774fc51089822d8be7aac119eeb14e2c788ccbe9",
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
    it(`${name} is the shared copy, by digest and against the Python SDK's`, () => {
      assert.equal(createHash("sha256").update(ours(name)).digest("hex"), digest,
        `test/fixtures/${name} is not the shared fixture -- change every copy ` +
        "together (both SDKs and the control plane), never one alone");

      if (!pythonRoot) return;
      const theirs = new URL(`tests/fixtures/${name}`, pythonRoot);
      assert.ok(existsSync(theirs),
        `the Python SDK checkout at ${pythonRoot.pathname} has no ` +
        `tests/fixtures/${name}: the two SDKs are testing different answers`);
      assert.ok(readFileSync(theirs).equals(ours(name)),
        `test/fixtures/${name} differs from the Python SDK's copy`);
    });
  }
});
