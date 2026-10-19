/**
 * Media a model saw, recorded as the OTel GenAI parts BOTH SDKs emit.
 *
 * `mediaPart` returns each vector of the shared `test/fixtures/media_parts.json`
 * -- the Python SDK's `adapters._media.media_part` returns the same, key order
 * included, in its own suite; `fixture_parity.test.js` holds the two copies of
 * the fixture to one set of bytes.
 */
import "./support/home.js";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { mediaPart } from "../src/model-boundary.js";

const { vectors } = JSON.parse(
  readFileSync(new URL("./fixtures/media_parts.json", import.meta.url), "utf8"));

describe("one medium as the GenAI part both SDKs emit", () => {
  for (const { input, part } of vectors) {
    it(`${JSON.stringify(input).slice(0, 60)}`, () => {
      // Mutation: change a key's order, the modality rule, or a missing MIME
      // type's null -> red (and the Python SDK's copy of this test).
      const got = mediaPart({
        mimeType: input.mime_type ?? null, data: input.data ?? null,
        uri: input.uri ?? null, modality: input.modality ?? null,
      });
      assert.equal(JSON.stringify(got), JSON.stringify(part));
    });
  }
});
