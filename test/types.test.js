import "./support/home.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// THE DECLARATIONS ARE HAND-WRITTEN, so what keeps them true is this: every
// runtime export of each typed entry point must be declared in its .d.ts, and
// every entry point package.json types must name a file that exists. A
// runtime export with no declaration is an import a TypeScript customer
// cannot write.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const declared = (dts) => {
  const text = readFileSync(new URL(`../${dts}`, import.meta.url), "utf8");
  const names = new Set();
  for (const m of text.matchAll(/export\s+(?:declare\s+)?(?:function|const|class|type|interface)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  if (/export default\b/.test(text)) names.add("default");
  return names;
};

describe("the TypeScript declarations", () => {
  for (const [entry, target] of Object.entries(pkg.exports)) {
    if (typeof target !== "object" || !target.types) continue;
    it(`declares every runtime export of ${entry}`, async () => {
      const mod = await import(new URL(`../${target.default}`, import.meta.url));
      const names = declared(target.types);
      const missing = Object.keys(mod).filter((k) => !names.has(k));
      assert.deepEqual(missing, [], `${target.types} does not declare: ${missing.join(", ")}`);
    });
  }

  it("names the root declarations as the package's types", () => {
    assert.equal(pkg.types, pkg.exports["."].types);
    assert.ok(pkg.files.includes("types"), "the declarations ship in the tarball");
  });
});
