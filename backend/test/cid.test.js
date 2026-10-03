import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { parseCidV1, verifyRawBlock, ipfsPathFromUri } from "../src/indexer/metadata.js";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function b32(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
const cidFor = (bytes) => "b" + b32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), crypto.createHash("sha256").update(bytes).digest()]));

test("a raw sha2-256 CIDv1 verifies the bytes it was made from", () => {
  const bytes = Buffer.from(JSON.stringify({ name: "x", image: "https://example.com/a.png" }));
  const cid = cidFor(bytes);
  assert.match(cid, /^bafkrei/); // same prefix Pinata gives small JSON files
  assert.equal(verifyRawBlock(cid, bytes), true);
});

test("tampered bytes are detected", () => {
  const bytes = Buffer.from('{"name":"honest"}');
  const cid = cidFor(bytes);
  assert.equal(verifyRawBlock(cid, Buffer.from('{"name":"evil!"}')), false);
  assert.equal(verifyRawBlock(cid, Buffer.concat([bytes, Buffer.from(" ")])), false);
});

test("CIDs that cannot be checked return null, never a false 'verified'", () => {
  assert.equal(verifyRawBlock("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", Buffer.from("x")), null); // CIDv0
  assert.equal(verifyRawBlock("not-a-cid", Buffer.from("x")), null);
  assert.equal(parseCidV1("bafkreiafygswghq65oys2q7auue2r4hx54zcxnzoannbrwikfikpbx524a").codec, 0x55);
  assert.equal(parseCidV1("b!!!"), null);
});

test("ipfs:// paths are validated before they are ever joined to a gateway URL", () => {
  assert.ok(ipfsPathFromUri("ipfs://bafkreiafygswghq65oys2q7auue2r4hx54zcxnzoannbrwikfikpbx524a"));
  assert.ok(ipfsPathFromUri("ipfs://bafkreiafygswghq65oys2q7auue2r4hx54zcxnzoannbrwikfikpbx524a/meta.json"));
  for (const bad of ["ipfs://../../etc/passwd", "ipfs://bafkreiafygswghq65oys2q7auue2r4hx54zcxnzoannbrwikfikpbx524a?x=1", "ipfs://bafkrei@evil.com", "https://evil.example/x", "ipfs://", null, 42]) {
    assert.equal(ipfsPathFromUri(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});
