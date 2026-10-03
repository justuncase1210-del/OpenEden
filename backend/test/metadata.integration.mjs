// Needs a Postgres (not run by `npm test`):
//   docker run -d --rm --name oe-pg-meta -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=oe -p 55436:5432 postgres:16-alpine
//   node test/metadata.integration.mjs
//
// Exercises the metadata pipeline against a fake gateway that behaves like the real world: rate-limits the first
// requests (429), serves tampered bytes for one CID, and only answers properly for the others.
import http from "node:http";
import crypto from "node:crypto";
import assert from "node:assert/strict";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const b32 = (buf) => { let bits = 0, v = 0, o = ""; for (const x of buf) { v = (v << 8) | x; bits += 8; while (bits >= 5) { o += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) o += B32[(v << (5 - bits)) & 31]; return o; };
const cidFor = (bytes) => "b" + b32(Buffer.concat([Buffer.from([1, 0x55, 0x12, 0x20]), crypto.createHash("sha256").update(bytes).digest()]));

const good = Buffer.from(JSON.stringify({ name: "Gateway NFT", description: "d", image: "https://example.com/i.png", attributes: [{ trait_type: "Hat", value: "Crown" }], external_url: "https://example.com", background_color: "#ABCDEF" }));
const evilFor = Buffer.from(JSON.stringify({ name: "Evil" }));
const goodCid = cidFor(good);
const honestCid = cidFor(Buffer.from('{"name":"honest"}'));    // gateway will answer this one with DIFFERENT bytes
const cachedBody = { name: "From Our Cache", image: "https://example.com/c.png" };
const cachedCid = cidFor(Buffer.from(JSON.stringify(cachedBody)));
const flakyCid = cidFor(Buffer.from('{"name":"Eventually"}'));
let flakyHits = 0, seenAccept = null;

const server = http.createServer((req, res) => {
  seenAccept = req.headers.accept;
  const cid = req.url.split("/ipfs/")[1];
  if (cid === goodCid) return res.end(good);
  if (cid === honestCid) return res.end(evilFor);                         // tampered
  if (cid === flakyCid) { flakyHits++; if (flakyHits <= 2) { res.statusCode = 429; return res.end("slow down"); } return res.end('{"name":"Eventually"}'); }
  res.statusCode = 404; res.end();
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

Object.assign(process.env, { DATABASE_URL: "postgresql://postgres:pw@localhost:55436/oe", BASE_RPC_URL: "http://127.0.0.1:1", IPFS_GATEWAYS: `http://127.0.0.1:${port}/ipfs/` });
const { pool, initDb } = await import("../src/db.js");
const { fetchTokenMetadata, retryMissingMetadata } = await import("../src/indexer/metadata.js");
await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
await initDb();
let n = 0; const ok = (m) => console.log(`  ok  ${++n} ${m}`);

let m = await fetchTokenMetadata(`ipfs://${goodCid}`);
assert.equal(m.ok, true); assert.equal(m.name, "Gateway NFT"); assert.equal(m.backgroundColor, "abcdef");
assert.match(seenAccept, /application\/vnd\.ipld\.raw/);
ok("metadata fetched through the gateway using the trustless raw-block request, extras sanitised");

m = await fetchTokenMetadata(`ipfs://${honestCid}`);
assert.equal(m.ok, false); assert.equal(m.name, null);
ok("a gateway that returns bytes NOT matching the CID is ignored (nothing tampered gets indexed)");

m = await fetchTokenMetadata("ipfs://bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
assert.equal(m.ok, false);
ok("an unknown CID fails cleanly without throwing");

await pool.query("INSERT INTO pinned_metadata (cid, body) VALUES ($1, $2::jsonb)", [cachedCid, JSON.stringify(cachedBody)]);
const before = flakyHits;
m = await fetchTokenMetadata(`ipfs://${cachedCid}`);
assert.equal(m.ok, true); assert.equal(m.name, "From Our Cache");
ok("metadata we pinned ourselves is served from our own database (no gateway involved)");

// retry job: an NFT whose metadata was unavailable at mint time gets filled in later
await pool.query("INSERT INTO agents (agent_id, name) VALUES ('a1', 'a')");
await pool.query("INSERT INTO nfts (token_id, contract_address, collection_id, owner_address, creator_agent_id, token_uri, metadata_attempts, metadata_next_try_at) VALUES (7, '0x0', 1, '0xabc', 'a1', $1, 1, now() - interval '1 second')", [`ipfs://${flakyCid}`]);
let fixed = await retryMissingMetadata();            // gateway answers 429 (hit 1)
assert.equal(fixed, 0);
let row = (await pool.query("SELECT name, metadata_attempts, metadata_next_try_at > now() AS backed_off FROM nfts WHERE token_id=7")).rows[0];
assert.equal(row.name, null); assert.equal(row.metadata_attempts, 2); assert.equal(row.backed_off, true);
ok("a failed retry is recorded and backed off (attempt 2, next try in the future)");

await pool.query("UPDATE nfts SET metadata_next_try_at = now() - interval '1 second' WHERE token_id=7");
fixed = await retryMissingMetadata();                // 429 again (hit 2)
assert.equal(fixed, 0);
await pool.query("UPDATE nfts SET metadata_next_try_at = now() - interval '1 second' WHERE token_id=7");
fixed = await retryMissingMetadata();                // now it answers
assert.equal(fixed, 1);
row = (await pool.query("SELECT name, metadata_next_try_at FROM nfts WHERE token_id=7")).rows[0];
assert.equal(row.name, "Eventually"); assert.equal(row.metadata_next_try_at, null);
ok("once the gateway recovers, the retry job fills in the NFT's name");

await pool.query("UPDATE nfts SET name = NULL, metadata_attempts = 12 WHERE token_id=7");
assert.equal(await retryMissingMetadata(), 0);
ok("after 12 attempts it stops retrying (no endless hammering)");

console.log(`\nALL ${n} METADATA CHECKS PASSED`);
server.close(); await pool.end(); process.exit(0);
