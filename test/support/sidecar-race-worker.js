/**
 * One of several writers racing to bind the same turns (`turns-sidecar.test.js`).
 * Every worker waits at a barrier before each turn, so they arrive together.
 */
import { join } from "node:path";
import { workerData } from "node:worker_threads";

import { recordExecutionFingerprint, recordTaskId } from "../../src/turns.js";

const { root, sab, writers, turns } = workerData;
const gate = new Int32Array(sab);
for (let k = 0; k < turns; k += 1) {
  const generation = Atomics.load(gate, 1);
  if (Atomics.add(gate, 0, 1) === writers - 1) {
    Atomics.store(gate, 0, 0);
    Atomics.add(gate, 1, 1);
    Atomics.notify(gate, 1);
  } else {
    Atomics.wait(gate, 1, generation);
  }
  const dir = join(root, `t${k}`);
  recordTaskId(dir, "case-1");
  recordExecutionFingerprint(dir, { execution_sha256: "a".repeat(64) });
}
