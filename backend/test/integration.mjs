// End-to-end check against REAL infrastructure (not run by `npm test`):
//   anvil --chain-id 84532            (local chain)
//   postgres on $DATABASE_URL         (e.g. docker run -p 55432:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=oe postgres:16-alpine)
//   forge build                       (artifacts in ../contracts/out)
//   node test/integration.mjs
//
// Deploys the contracts, then exercises the actual MCP tools, the indexer and
// the signed-request routes together.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.INT_RPC || "http://127.0.0.1:8545";
const DB = process.env.DATABASE_URL || "postgresql://postgres:pw@localhost:55432/oe";
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
];
const [owner, A, B, C, D] = KEYS.map((k) => privateKeyToAccount(k));

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${label}`);
    await sleep(250);
  }
}

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const wallet = (account) => createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
const art = (file, name) => JSON.parse(fs.readFileSync(path.join(here, "../../contracts/out", file, `${name}.json`), "utf8"));

async function deploy(account, artifact, args = []) {
  const hash = await wallet(account).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
}
async function send(account, address, abi, functionName, args = []) {
  const hash = await wallet(account).writeContract({ address, abi, functionName, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", `${functionName} reverted`);
}
const warp = async (s) => { await pub.request({ method: "evm_increaseTime", params: [s] }); await pub.request({ method: "evm_mine", params: [] }); };

// ---------------------------------------------------------------- deploy
console.log("deploying contracts to", RPC);
const registryArt = art("AgentRegistry.sol", "AgentRegistry");
const usdcArt = art("Marketplace.t.sol", "MockUSDC");
const nftArt = art("AgentNFT.sol", "AgentNFT");
const marketArt = art("Marketplace.sol", "Marketplace");
const offersArt = art("Offers.sol", "Offers");
const commArt = art("CommunityRegistry.sol", "CommunityRegistry");

const registry = await deploy(owner, registryArt, [owner.address]);
const usdc = await deploy(owner, usdcArt);
const nft = await deploy(owner, nftArt, [owner.address, registry, usdc]);
const market = await deploy(owner, marketArt, [owner.address, usdc, owner.address, registry, nft]);
await send(owner, nft, nftArt.abi, "setMarketplace", [market]);
const offers = await deploy(owner, offersArt, [owner.address, usdc, registry, nft, market]);
await send(owner, market, marketArt.abi, "setOffersContract", [offers]);
const comm = await deploy(owner, commArt, [registry]);

Object.assign(process.env, {
  DATABASE_URL: DB, BASE_RPC_URL: RPC, BASE_CHAIN_ID: "84532",
  AGENT_REGISTRY_ADDRESS: registry, NFT_CONTRACT_ADDRESS: nft, MARKETPLACE_CONTRACT_ADDRESS: market,
  OFFERS_CONTRACT_ADDRESS: offers, COMMUNITY_REGISTRY_ADDRESS: comm, RELAYER_PRIVATE_KEY: KEYS[0],
  INDEXER_START_BLOCK: "0", INDEXER_POLLING_INTERVAL_MS: "300", INDEXER_CONFIRMATIONS: "0",
  INDEXER_CHUNK_SIZE: "500", REGISTRATIONS_PER_IP_PER_HOUR: "50", PINATA_JWT: "",
});

// ---------------------------------------------------------------- backend
const { pool, initDb } = await import("../src/db.js");
await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
await initDb();
await initDb(); // migrations must be idempotent
ok("schema + migrations apply twice cleanly");

const { createMcpServer } = await import("../src/mcp/server.js");
const { buildRegistrationMessage } = await import("../src/mcp/registrationMessage.js");
const { buildLinkAuthorizationMessage, buildRequestMessage, hashBody, verifyAgentSignature } = await import("../src/auth.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const mcp = createMcpServer({
  paidBrowseListings: (f) => f, paidGetNft: (f) => f, paidListCommunities: (f) => f, paidEstimateFloor: (f) => f,
  paidEstimateRarity: (f) => f, paidDetectWashTrading: (f) => f,
});
const [ct, st] = InMemoryTransport.createLinkedPair();
await mcp.connect(st);
const client = new Client({ name: "it", version: "1" });
await client.connect(ct);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
};

async function register(acct, name) {
  const timestamp = Date.now();
  const signature = await acct.signMessage({ message: buildRegistrationMessage({ walletAddress: acct.address, timestamp }) });
  return call("register_agent", { name, walletAddress: acct.address, timestamp, signature });
}

// ---- registration
const regA = await register(A, "agent-a");
assert.ok(regA.body.agentId && regA.body.onChainRegistration.success, JSON.stringify(regA));
const regA2 = await register(A, "agent-a-again");
assert.equal(regA2.body.agentId, regA.body.agentId);
assert.equal((await pool.query("SELECT COUNT(*) FROM agents")).rows[0].count, "1");
ok("register_agent is idempotent per wallet (replay returns same agentId, no duplicate row)");
const regB = await register(B, "agent-b");
const agentA = regA.body.agentId, agentB = regB.body.agentId;
assert.equal(await pub.readContract({ address: registry, abi: registryArt.abi, functionName: "isAgentWallet", args: [A.address] }), true);
ok("wallet allowlisted on-chain");

// ---- link_wallet takeover (finding 2)
{
  const timestamp = Date.now();
  const sigC = await C.signMessage({ message: buildRegistrationMessage({ walletAddress: C.address, timestamp }) });
  const bogus = await C.signMessage({ message: buildLinkAuthorizationMessage({ agentId: agentA, newWalletAddress: C.address, timestamp }) });
  const attack = await call("link_wallet", { agentId: agentA, newWalletAddress: C.address, timestamp, signature: sigC, ownerSignature: bogus });
  assert.ok(attack.isError && /already linked/.test(attack.body.error), JSON.stringify(attack));
  assert.equal((await pool.query("SELECT 1 FROM agent_wallets WHERE wallet_address=$1", [C.address.toLowerCase()])).rowCount, 0);
  ok("link_wallet: attacker cannot attach their wallet to someone else's agentId");

  const sigD = await D.signMessage({ message: buildRegistrationMessage({ walletAddress: D.address, timestamp }) });
  const auth = await A.signMessage({ message: buildLinkAuthorizationMessage({ agentId: agentA, newWalletAddress: D.address, timestamp }) });
  const good = await call("link_wallet", { agentId: agentA, newWalletAddress: D.address, timestamp, signature: sigD, ownerSignature: auth });
  assert.ok(!good.isError && good.body.onChainRegistration.success, JSON.stringify(good));
  ok("link_wallet: owner-authorised link succeeds");

  const steal = await call("link_wallet", { agentId: agentB, newWalletAddress: D.address, timestamp, signature: sigD,
    ownerSignature: await B.signMessage({ message: buildLinkAuthorizationMessage({ agentId: agentB, newWalletAddress: D.address, timestamp }) }) });
  assert.ok(steal.isError && /different agent/.test(steal.body.error), JSON.stringify(steal));
  ok("link_wallet: a wallet already owned by agent A cannot be moved to agent B");
}

// ---- on-chain activity
const usdcAbi = usdcArt.abi, nftAbi = nftArt.abi, marketAbi = marketArt.abi, commAbi = commArt.abi;
await send(A, nft, nftAbi, "createCollection", [10n]);
await send(B, nft, nftAbi, "mint", [1n, "ipfs://not-a-valid-cid", "0x0000000000000000000000000000000000000000", 0, 2n ** 255n]);
await warp(20);
await send(B, nft, nftAbi, "mint", [1n, "ipfs://also-bad", "0x0000000000000000000000000000000000000000", 0, 2n ** 255n]);
await send(A, nft, nftAbi, "endMint", [1n]);
await send(B, nft, nftAbi, "approve", [market, 1n]);
await send(B, market, marketAbi, "list", [1n, 10_000_000n]);
await send(owner, usdc, usdcAbi, "mint", [A.address, 50_000_000n]);
await send(A, usdc, usdcAbi, "approve", [market, 50_000_000n]);
await send(A, market, marketAbi, "buy", [1n]);
await send(A, comm, commAbi, "createCommunity", ["test-comm"]);
await send(B, comm, commAbi, "join", ["test-comm"]);
ok("chain activity: collection, mints, list, buy, community create/join");

// ---- indexer
const { startIndexer } = await import("../src/indexer/index.js");
await startIndexer();
await until(async () => (await pool.query("SELECT 1 FROM listings WHERE sold_at IS NOT NULL")).rowCount, "sale indexed");
const sold = (await pool.query("SELECT buyer_address, seller_address, sold_at, price_usdc FROM listings WHERE listing_id=1")).rows[0];
assert.equal(sold.buyer_address, A.address.toLowerCase());
assert.equal(sold.seller_address, B.address.toLowerCase());
assert.equal(String(sold.price_usdc), "10.000000");
ok("indexer: Sold writes buyer_address, exact price");
const nft1 = (await pool.query("SELECT owner_address, creator_agent_id FROM nfts WHERE token_id=1")).rows[0];
assert.equal(nft1.owner_address, A.address.toLowerCase());
assert.equal(nft1.creator_agent_id, agentB);
ok("indexer: ownership follows the sale; addresses stored lowercase");
const mcount = await until(async () => { const r = (await pool.query("SELECT member_count FROM communities WHERE slug='test-comm'")).rows[0]; return r && r.member_count === 2 ? r : null; }, "member_count=2");
ok("indexer: community member_count derived from membership rows");
const col = (await pool.query("SELECT minted_count, mint_ended FROM collections WHERE collection_id=1")).rows[0];
assert.equal(String(col.minted_count), "2");
ok("indexer: collection minted_count correct");
// idempotent replay: reset cursor and re-run the same range through the handlers
const { HANDLERS } = await import("../src/indexer/handlers.js");
await HANDLERS.MemberJoined({ slugHash: keccak256(toBytes("test-comm")), member: B.address });
await HANDLERS.Minted({ tokenId: 1n, collectionId: 1n, to: B.address, agentId: agentB, tokenURI: "x" }, { timestamp: new Date() });
assert.equal((await pool.query("SELECT member_count FROM communities WHERE slug='test-comm'")).rows[0].member_count, 2);
assert.equal((await pool.query("SELECT owner_address FROM nfts WHERE token_id=1")).rows[0].owner_address, A.address.toLowerCase());
assert.equal(String((await pool.query("SELECT minted_count FROM collections WHERE collection_id=1")).rows[0].minted_count), "2");
ok("indexer: replaying events does not double-count or revert owner");

// wash-trading tool now sees the trade
const wash = await call("detect_wash_trading", { walletAddress: A.address });
assert.equal(wash.isError, false);
ok("detect_wash_trading runs against populated buyer_address");

// ---------------------------------------------------------------- HTTP auth
const express = (await import("express")).default;
const { nftsRouter } = await import("../src/routes/nfts.js");
const { communityRouter } = await import("../src/routes/community.js");
const { watchlistRouter } = await import("../src/routes/watchlist.js");
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb", verify: (req, res, buf) => { req.rawBody = buf; } }));
for (const [m, p] of [["post", "/api/nfts/:tokenId/community"], ["post", "/api/community/post"], ["post", "/api/community/metadata"], ["post", "/api/watchlist"], ["delete", "/api/watchlist/:id"]]) app[m](p, verifyAgentSignature);
for (const r of [nftsRouter, communityRouter, watchlistRouter]) {
  for (const layer of r.stack) if (layer.route) for (const l of layer.route.stack) { const fn = l.handle; l.handle = (q, s, n) => Promise.resolve(fn(q, s, n)).catch(n); }
}
app.use("/api/nfts", nftsRouter); app.use("/api/community", communityRouter); app.use("/api/watchlist", watchlistRouter);
app.use((err, req, res, next) => { console.error("   [route error]", err.message); res.status(500).json({ error: "internal server error" }); });
const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;

async function signed(acct, agentId, method, p, bodyObj, { tamper } = {}) {
  const raw = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const timestamp = String(Date.now());
  const message = buildRequestMessage({ agentId, method, path: p, timestamp, bodyHash: hashBody(raw ? Buffer.from(raw) : undefined) });
  const signature = await acct.signMessage({ message });
  const sendRaw = tamper ? JSON.stringify(tamper) : raw;
  const res = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-agent-id": agentId, "x-timestamp": timestamp, "x-signature": signature }, body: sendRaw });
  return { status: res.status, body: await res.json().catch(() => ({})), replay: () => fetch(base + p, { method, headers: { "content-type": "application/json", "x-agent-id": agentId, "x-timestamp": timestamp, "x-signature": signature }, body: sendRaw }) };
}

let r = await fetch(`${base}/api/watchlist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: agentB, tokenId: 1 }) });
assert.equal(r.status, 401);
ok("HTTP: unsigned request that merely names an agentId is rejected (401)");

r = await signed(C, agentB, "POST", "/api/watchlist", { tokenId: 1 });
assert.equal(r.status, 403);
ok("HTTP: stranger's wallet claiming agent B's id is rejected (403)");

r = await signed(B, agentB, "POST", "/api/watchlist", { tokenId: 1 });
assert.equal(r.status, 200, JSON.stringify(r.body));
ok("HTTP: correctly signed request succeeds");

const rep = await r.replay();
assert.equal(rep.status, 401);
ok("HTTP: replaying the same signature is rejected");

r = await signed(B, agentB, "POST", "/api/watchlist", { tokenId: 1 }, { tamper: { collectionId: 1 } });
assert.equal(r.status, 403);
ok("HTTP: tampering with the body after signing is rejected");

r = await signed(D, agentA, "POST", "/api/watchlist", { collectionId: 1 });
assert.equal(r.status, 200, JSON.stringify(r.body));
ok("HTTP: a linked secondary wallet can act for its agent");

// community flow. Token 1 is owned by A but was minted by B.
r = await signed(C, agentA, "POST", "/api/nfts/1/community", { communitySlug: "test-comm" });
assert.equal(r.status, 403);
r = await signed(B, agentB, "POST", "/api/nfts/1/community", { communitySlug: "test-comm" });
assert.equal(r.status, 200, JSON.stringify(r.body));
r = await signed(A, agentA, "POST", "/api/nfts/1/community", { communitySlug: "test-comm" });
assert.equal(r.status, 409, JSON.stringify(r.body));
ok("HTTP: token->community association works once, second attempt is 409 (atomic)");

r = await signed(B, agentB, "POST", "/api/community/post", { communitySlug: "test-comm", body: "hello" });
assert.equal(r.status, 200, JSON.stringify(r.body));
r = await signed(B, agentB, "POST", "/api/community/post", { communitySlug: "test-comm", body: ["x"] });
assert.equal(r.status, 400);
ok("HTTP: member who minted into the community can post; wrong-typed body is a clean 400");

// concurrent posts must not race past the 3/day cap
const results = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => signed(B, agentB, "POST", "/api/community/post", { communitySlug: "test-comm", body: `race ${i}` })));
const accepted = results.filter((x) => x.status === 200).length;
assert.equal(accepted, 2, `expected exactly 2 more posts to land (1 already used), got ${accepted}`);
assert.equal(Number((await pool.query("SELECT COUNT(*) FROM community_posts")).rows[0].count), 3);
ok("HTTP: concurrent posts cannot exceed the 3/day cap");

r = await signed(D, agentA, "POST", "/api/community/post", { communitySlug: "test-comm", body: "from a wallet that never joined" });
assert.equal(r.status, 403, JSON.stringify(r.body));
r = await signed(A, agentA, "POST", "/api/community/post", { communitySlug: "test-comm", body: "I created it and own token 1" });
assert.equal(r.status, 200, JSON.stringify(r.body));
ok("HTTP: signing wallet must itself be an on-chain member; a member that owns an associated NFT can post");

console.log(`
ALL ${pass} CHECKS PASSED`);
server.close();
await pool.end();
process.exit(0);
