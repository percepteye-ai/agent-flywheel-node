/**
 * A captured error keeps the exception line, in both hosts' classifiers.
 *
 * Each classifier used to keep the first 1000 characters of a stated error.
 * A traceback ends with the exception class and its message, after however
 * many frames, so the head cut deleted exactly the part a model can learn to
 * correct from, and said nothing about having done it. The bound itself is
 * shared with the Python SDK; that SDK's parity test drives this module and
 * both classifiers and requires the same strings it produces.
 */
import "./support/home.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bounded, elision, MAX_BODY_CHARS } from "../src/body-bound.js";
import { classify } from "../src/classify.js";
import { classifyDsh } from "../src/dsh-classify.js";

const TAIL = 'ValueError: city "Paris " has a trailing space';

function longTraceback(frames = 400) {
  let body = "Traceback (most recent call last):\n";
  for (let i = 0; i < frames; i++) {
    body += `  File "/app/mod${i}.py", line ${i}, in handler\n    return step${i}()\n`;
  }
  return body + TAIL;
}

function statedCount(text) {
  const m = /…\[(\d+) chars elided by the SDK capture bound\]…/.exec(text);
  assert.ok(m, text);
  return Number(m[1]);
}

const markers = (text) => text.split("elided by the SDK capture bound").length - 1;

describe("the body bound", () => {
  it("returns a body within the bound untouched", () => {
    assert.equal(bounded("stdout: fine\n"), "stdout: fine\n");
  });

  it("keeps both ends of a long traceback, within the bound, marker included", () => {
    const out = bounded(longTraceback());
    assert.ok(out.startsWith("Traceback (most recent call last):"));
    assert.ok(out.endsWith(TAIL));
    assert.equal(Array.from(out).length, MAX_BODY_CHARS);
    assert.equal(markers(out), 1);
  });

  it("states the count actually removed, across the marker's digit boundary", () => {
    for (let size = 1000; size < 1100; size++) {
      const out = bounded("x".repeat(size), 100);
      const kept = out.length - elision(statedCount(out)).length;
      assert.equal(out.length, 100);
      assert.equal(statedCount(out), size - kept);
    }
  });

  it("counts code points, so an astral character is one character and is never split", () => {
    const out = bounded("😀".repeat(5000));
    assert.equal(Array.from(out).length, MAX_BODY_CHARS);
    assert.ok(out.isWellFormed(), "a surrogate pair was split");
  });

  it("keeps the tail when the limit cannot hold the marker", () => {
    assert.equal(bounded(longTraceback(), 20), TAIL.slice(-20));
    assert.equal(bounded(longTraceback(), 0), "");
  });
});

describe("a stated error keeps its exception line", () => {
  it("in the OpenClaw classifier", () => {
    const v = classify("exec", longTraceback(), undefined);
    assert.equal(v.outcome, "failed");
    assert.ok(v.error.endsWith(TAIL));
    assert.equal(markers(v.error), 1);
    assert.equal(v.error, bounded(longTraceback()));
  });

  it("in the DeepSeek Harness classifier", () => {
    const v = classifyDsh("bash", {
      isError: true, error: { message: longTraceback(), info: "EIO" },
    });
    assert.equal(v.outcome, "failed");
    assert.ok(v.error.endsWith(TAIL));
    assert.equal(markers(v.error), 1);
    assert.equal(v.error, bounded(longTraceback()));
  });

  it("verbatim when it is short", () => {
    assert.equal(classify("exec", TAIL, undefined).error, TAIL);
    assert.equal(classifyDsh("bash", { isError: true, error: { message: TAIL } }).error, TAIL);
  });
});
