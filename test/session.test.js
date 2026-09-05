/**
 * The two path helpers, and the rule that keeps them from escaping.
 *
 * This file used to test a `SessionStore` and an on-disk report spool that no
 * production code imported -- the tests were the only consumer. Both are gone
 * (see `session.js`); what is left is what `capture.js` actually uses.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { percepteyeHome, safeSegment } from "../src/session.js";

describe("where this package writes", () => {
  it("honours PERCEPTEYE_HOME above the default", () => {
    assert.equal(percepteyeHome({ PERCEPTEYE_HOME: "/x" }), "/x");
  });

  it("falls back to a dotdir in the user's home", () => {
    assert.match(percepteyeHome({}), /\.percepteye$/);
  });
});

describe("a host-supplied id is untrusted input", () => {
  it("cannot escape its directory", () => {
    // No dots survive at all, so `..` cannot reach the parent.
    for (const hostile of ["../../etc", "..", "a/b", "./x"]) {
      const seg = safeSegment(hostile);
      assert.ok(!seg.includes("/"), `${hostile} kept a separator: ${seg}`);
      assert.ok(!seg.includes("."), `${hostile} kept a dot: ${seg}`);
    }
  });

  it("never yields an empty segment", () => {
    for (const empty of ["", "///", null, undefined, "..."]) {
      assert.equal(safeSegment(empty), "unknown");
    }
  });

  it("is bounded, because a filename is bounded", () => {
    assert.equal(safeSegment("a".repeat(500)).length, 120);
  });

  it("keeps ordinary ids intact", () => {
    assert.equal(safeSegment("agent_main-1"), "agent_main-1");
  });
});
