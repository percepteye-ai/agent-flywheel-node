import "./support/home.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { practiceLine } from "../src/rollout.js";

describe("practice's two switches, as the control plane names them", () => {
  it("names Mission Control's switch, in the control plane's words", () => {
    // Mutation: read the switch off anything but `practice.missing`.
    const line = practiceLine({ practice: { missing: [{
      switch: "practice_consent", code: "practice_rollouts_not_enabled",
      detail: "practice runs are not allowed for this agent.",
    }] } });
    assert.match(line, /Allow practice runs/);
    assert.match(line, /practice runs are not allowed for this agent\.$/);
  });

  it("says nothing when it is on, or when the control plane is older", () => {
    assert.equal(practiceLine({ practice: { missing: [] } }), null);
    assert.equal(practiceLine({ agent_id: "a" }), null);
    assert.equal(practiceLine(undefined), null);
  });
});
