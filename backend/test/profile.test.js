import test from "node:test";
import assert from "node:assert/strict";
import { validateProfile, validateExtraMetadata, sniffImageType } from "../src/profile.js";

test("profile: accepts a full valid profile and normalises it", () => {
  const { errors, values } = validateProfile({
    name: "  Neon Cats ", symbol: "ncat", description: "cats", imageUrl: "ipfs://bafyexample", bannerUrl: "https://example.com/b.png", externalUrl: "https://example.com",
  });
  assert.deepEqual(errors, []);
  assert.equal(values.name, "Neon Cats");
  assert.equal(values.symbol, "NCAT");
  assert.equal(values.image_url, "ipfs://bafyexample");
  assert.equal(values.banner_url, "https://example.com/b.png");
  assert.equal(values.external_url, "https://example.com");
});

test("profile: partial updates only return the fields that were sent", () => {
  const { errors, values } = validateProfile({ description: "only this" });
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(values), ["description"]);
});

test("profile: null or empty string clears optional fields", () => {
  const { errors, values } = validateProfile({ symbol: null, description: "", imageUrl: null });
  assert.deepEqual(errors, []);
  assert.deepEqual(values, { symbol: null, description: null, image_url: null });
});

test("profile: rejects dangerous or malformed URLs", () => {
  for (const bad of ["javascript:alert(1)", "http://insecure.example/x.png", "data:image/png;base64,AAAA", "file:///etc/passwd", "https://user:pass@evil.example/x", "https://exa mple.com", "https://x.com/\nfoo"]) {
    const { errors } = validateProfile({ imageUrl: bad });
    assert.ok(errors.length > 0, `should reject ${JSON.stringify(bad)}`);
  }
  assert.ok(validateProfile({ externalUrl: "ipfs://bafyexample" }).errors.length > 0, "external link must be https only");
});

test("profile: rejects bad names/symbols and empty updates", () => {
  assert.ok(validateProfile({ name: "" }).errors.length > 0);
  assert.ok(validateProfile({ name: "x".repeat(101) }).errors.length > 0);
  assert.ok(validateProfile({ name: "line\nbreak" }).errors.length > 0);
  assert.ok(validateProfile({ name: { toString: () => "obj" } }).errors.length > 0);
  assert.ok(validateProfile({ symbol: "TOO-LONG-SYMBOL!" }).errors.length > 0);
  assert.ok(validateProfile({}).errors.length > 0, "an update with nothing in it is an error");
  assert.ok(validateProfile(null).errors.length > 0);
});

test("profile: unknown fields are ignored, so they can never reach SQL", () => {
  const { values } = validateProfile({ name: "ok", verified: true, creator_agent_id: "x", "name; DROP TABLE collections": 1 });
  assert.deepEqual(Object.keys(values), ["name"]);
});

test("extra metadata: valid values are normalised, invalid ones error", () => {
  const ok = validateExtraMetadata({ external_url: "https://example.com", animation_url: "ipfs://bafyanim", background_color: "#AABBCC" });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.values.background_color, "aabbcc");
  assert.ok(validateExtraMetadata({ external_url: "http://example.com" }).errors.length > 0);
  assert.ok(validateExtraMetadata({ animation_url: "javascript:1" }).errors.length > 0);
  assert.ok(validateExtraMetadata({ background_color: "red" }).errors.length > 0);
  assert.deepEqual(validateExtraMetadata({}).values, {});
});

test("sniffImageType identifies real images by content and refuses everything else", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
  const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20)]);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(10)]);
  assert.equal(sniffImageType(png), "image/png");
  assert.equal(sniffImageType(jpg), "image/jpeg");
  assert.equal(sniffImageType(gif), "image/gif");
  assert.equal(sniffImageType(webp), "image/webp");
  assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null, "SVG is refused");
  assert.equal(sniffImageType(Buffer.from("<html><script>alert(1)</script></html>")), null);
  assert.equal(sniffImageType(Buffer.from("MZ" + "x".repeat(30))), null, "an executable is not an image");
  assert.equal(sniffImageType(Buffer.alloc(3)), null, "too short");
  assert.equal(sniffImageType("not a buffer"), null);
});
