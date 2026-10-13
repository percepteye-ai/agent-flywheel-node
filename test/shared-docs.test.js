/**
 * The customer pages both SDKs share say the same thing in both repositories.
 *
 * The README, the quickstart, the production guide, the OpenTelemetry push
 * page, the FAQ, the troubleshooting page and the dashboard click paths exist
 * here and in the Python SDK's repository. Everything outside a
 * `<!-- lang -->` ... `<!-- /lang -->` region is byte-identical in both
 * copies, and both copies have the same number of regions in the same places;
 * only what sits inside a region is this language's own. The README is
 * compared after its links to the docs pages are written the same way in both
 * (`docs/` here, `website/docs/` there).
 *
 * The Python suite holds the same rule from its side
 * (`tests/test_shared_docs_match_node.py`), so an edit to either copy alone
 * turns one of the two red. Like the tracing parity test, this one runs when a
 * Python checkout sits beside this one, as `percepteye-agent-flywheel`.
 */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const PY = new URL("../../percepteye-agent-flywheel/", import.meta.url);
const HERE = new URL("../", import.meta.url);

/** This repository's copy -> the Python repository's copy. */
const SHARED = {
  "README.md": "README.md",
  "docs/quickstart.md": "website/docs/quickstart.md",
  "docs/production.md": "website/docs/production.md",
  "docs/otlp.md": "website/docs/otlp.md",
  "docs/faq.md": "website/docs/faq.md",
  "docs/troubleshooting.md": "website/docs/troubleshooting.md",
  "docs/dashboard.md": "website/docs/dashboard.md",
};

const LANG = /<!-- lang -->[\s\S]*?<!-- \/lang -->/g;

function sharedParts(text, readme) {
  const normal = readme ? text.replaceAll("](website/docs/", "](docs/") : text;
  return normal.split(LANG);
}

describe("the pages shared with the Python SDK", () => {
  for (const [ours, theirs] of Object.entries(SHARED)) {
    it(`${ours} matches the Python SDK's ${theirs}`, (t) => {
      const there = new URL(theirs, PY);
      if (!existsSync(new URL("src/agent_flywheel/", PY))) {
        t.skip("python sdk checkout not present");
        return;
      }
      assert.ok(existsSync(there), `the Python SDK has no ${theirs} to match ${ours}`);
      const readme = ours === "README.md";
      const a = sharedParts(readFileSync(new URL(ours, HERE), "utf8"), readme);
      const b = sharedParts(readFileSync(there, "utf8"), readme);
      assert.equal(a.length, b.length,
        `${ours}: ${a.length - 1} language region(s) here, ${b.length - 1} in the Python copy`);
      a.forEach((part, i) => {
        assert.equal(part, b[i], `${ours}: shared part ${i} differs from the Python copy`);
      });
    });
  }

  it("closes every language region it opens", () => {
    for (const ours of Object.keys(SHARED)) {
      const text = readFileSync(new URL(ours, HERE), "utf8");
      const opened = text.split("<!-- lang -->").length - 1;
      const closed = text.split("<!-- /lang -->").length - 1;
      const regions = (text.match(LANG) ?? []).length;
      assert.ok(opened === closed && closed === regions,
        `${ours}: ${opened} opened, ${closed} closed`);
    }
  });
});
