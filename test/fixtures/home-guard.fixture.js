/**
 * Run by `home-isolation.test.js` in a child `node --test`, never by the suite
 * itself (it does not match `test/*.test.js`). One rollout driver, built with
 * a home of its own when HOME_GUARD_FIXTURE=own and with none otherwise, then
 * one claim, which drains the outbox it resolved.
 */
import { testEnv } from "../support/home.js";
import { it } from "node:test";

import { createRolloutDriver } from "../../src/rollout.js";

it("builds a rollout driver and claims once", async () => {
  const driver = createRolloutDriver({
    ...(process.env.HOME_GUARD_FIXTURE === "own" ? { env: testEnv() } : {}),
    transport: {
      claim: async () => ({ rollouts: [] }),
      report: async () => {},
      abandon: async () => {},
    },
    enqueue: async () => ({ enqueued: true }),
  });
  await driver.onSessionStart({ sessionKey: "s1" });
});
