import test from "node:test";
import assert from "node:assert/strict";
import { computeRarity, sanitizeAttributes } from "../src/rarity.js";

test("prototype-pollution trait names do not touch Object.prototype", () => {
  const rows = [
    { token_id: "1", attributes: [{ trait_type: "__proto__", value: "polluted" }, { trait_type: "constructor", value: "x" }] },
    { token_id: "2", attributes: [{ trait_type: "__proto__", value: "polluted" }] },
  ];
  const result = computeRarity(rows);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(result.traitFrequency["__proto__"]["polluted"], 2);
  assert.equal(result.tokenRarity.length, 2);
});

test("malformed attributes are dropped, not thrown on", () => {
  assert.deepEqual(sanitizeAttributes([null, 5, { trait_type: "", value: 1 }, { trait_type: "a", value: {} }, { trait_type: "ok", value: 3 }]), [
    { trait_type: "ok", value: "3" },
  ]);
  assert.equal(sanitizeAttributes("nope"), null);
  assert.doesNotThrow(() => computeRarity([{ token_id: "1", attributes: null }]));
});

test("rarer traits score higher", () => {
  const rows = [
    { token_id: "1", attributes: [{ trait_type: "bg", value: "red" }] },
    { token_id: "2", attributes: [{ trait_type: "bg", value: "blue" }] },
    { token_id: "3", attributes: [{ trait_type: "bg", value: "blue" }] },
  ];
  const { tokenRarity } = computeRarity(rows);
  assert.equal(tokenRarity[0].tokenId, "1");
});
