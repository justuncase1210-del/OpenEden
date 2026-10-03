// A complete OpenEden stack on YOUR machine, with fake money, for running the test scripts for free:
//   - deploys the real contracts (with a mock USDC) to a local chain
//   - runs the real REST routes, MCP tools, wallet-signature auth and indexer against a local Postgres
// The ONLY thing it leaves out is the x402 payment gate (that needs Coinbase's live facilitator), so
// paid calls simply aren't charged here. Never deploy this file - it is for testing only.
//
// Prerequisites (3 terminals, or run the first two in the background):
//   1.  anvil --chain-id 84532
//   2.  docker run -d --rm --name oe-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=oe -p 55435:5432 postgres:16-alpine
//   3.  (cd ../contracts && forge build)
// Then:
//   node scripts/local-stack.mjs                     <- leave running
// and in another terminal:
//   $env:BACKEND_URL="http://127.0.0.1:4999"; $env:BASE_RPC_URL="http://127.0.0.1:8545"
//   $env:TEST_FUNDER_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"   # anvil's public test key #0
//   node scripts/test-marketplace-cycle.mjs ; node scripts/test-api-and-tools.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.BASE_RPC_URL || "http://127.0.0.1:8545";
const DB = process.env.DATABASE_URL || "postgresql://postgres:pw@localhost:55435/oe";
const PORT = Number(process.env.PORT || 4999);
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil account #0 (public, worthless)
const owner = privateKeyToAccount(DEPLOYER_KEY);

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const wallet = createWalletClient({ account: owner, chain: baseSepolia, transport: http(RPC) });
const art = (file, name) => JSON.parse(fs.readFileSync(path.join(here, "../../contracts/out", file, `${name}.json`), "utf8"));
async function deploy(artifact, args = []) {
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
}
async function send(address, abi, functionName, args = []) {
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address, abi, functionName, args }) });
}

try { await pub.getChainId(); } catch { console.error(`No chain at ${RPC}. Start one first:  anvil --chain-id 84532`); process.exit(1); }
console.log("deploying contracts to", RPC);
const registryArt = art("AgentRegistry.sol", "AgentRegistry"), usdcArt = art("Marketplace.t.sol", "MockUSDC");
const nftArt = art("AgentNFT.sol", "AgentNFT"), marketArt = art("Marketplace.sol", "Marketplace");
const offersArt = art("Offers.sol", "Offers"), commArt = art("CommunityRegistry.sol", "CommunityRegistry");

const registry = await deploy(registryArt, [owner.address]);
const usdc = await deploy(usdcArt);
const nft = await deploy(nftArt, [owner.address, registry, usdc]);
// fee recipient = a fresh address so fee payouts can be asserted exactly
const feeRecipient = "0x000000000000000000000000000000000000fee0";
const market = await deploy(marketArt, [owner.address, usdc, feeRecipient, registry, nft]);
await send(nft, nftArt.abi, "setMarketplace", [market]);
const offers = await deploy(offersArt, [owner.address, usdc, registry, nft, market]);
await send(market, marketArt.abi, "setOffersContract", [offers]);
const comm = await deploy(commArt, [registry]);
await send(usdc, usdcArt.abi, "mint", [owner.address, 1_000_000_000n]); // 1,000 fake USDC for the funder

Object.assign(process.env, {
  DATABASE_URL: DB, BASE_RPC_URL: RPC, BASE_CHAIN_ID: "84532", USDC_ADDRESS: usdc,
  AGENT_REGISTRY_ADDRESS: registry, NFT_CONTRACT_ADDRESS: nft, MARKETPLACE_CONTRACT_ADDRESS: market,
  OFFERS_CONTRACT_ADDRESS: offers, COMMUNITY_REGISTRY_ADDRESS: comm, RELAYER_PRIVATE_KEY: DEPLOYER_KEY,
  INDEXER_START_BLOCK: "0", INDEXER_POLLING_INTERVAL_MS: "500", INDEXER_CONFIRMATIONS: "0", INDEXER_CHUNK_SIZE: "500",
  REGISTRATIONS_PER_IP_PER_HOUR: "1000", ENABLE_IMAGE_UPLOAD: "true", PINATA_JWT: "local-fake-pinata", ADMIN_SECRET: "local-only",
  IPFS_GATEWAYS: `http://127.0.0.1:${PORT}/ipfs/`,
});

// ---- fake Pinata + IPFS gateway (so prepare-metadata and the indexer's metadata fetch are exercised) ----
import crypto from "node:crypto";
const pins = new Map();
const b32 = (buf) => { const A = "abcdefghijklmnopqrstuvwxyz234567"; let bits = 0, val = 0, out = ""; for (const byte of buf) { val = (val << 8) | byte; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += A[(val << (5 - bits)) & 31]; return out; };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("api.pinata.cloud/pinning/pinJSONToIPFS")) {
    const json = JSON.stringify(JSON.parse(init.body).pinataContent);
    const cid = "b" + b32(crypto.createHash("sha256").update(json).digest());
    pins.set(cid, { body: json, type: "application/json" });
    return new Response(JSON.stringify({ IpfsHash: cid }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u.includes("api.pinata.cloud/pinning/pinFileToIPFS")) {
    const file = init.body.get("file");
    const buf = Buffer.from(await file.arrayBuffer());
    const cid = "b" + b32(crypto.createHash("sha256").update(buf).digest());
    pins.set(cid, { body: buf, type: file.type });
    return new Response(JSON.stringify({ IpfsHash: cid }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(url, init);
};

const { default: express } = await import("express");
const { pool, initDb } = await import("../src/db.js");
const { verifyAgentSignature } = await import("../src/auth.js");
const { createMcpServer } = await import("../src/mcp/server.js");
const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
const { startIndexer } = await import("../src/indexer/index.js");
const routers = {
  "/api/nfts": (await import("../src/routes/nfts.js")).nftsRouter,
  "/api/marketplace": (await import("../src/routes/marketplace.js")).marketplaceRouter,
  "/api/community": (await import("../src/routes/community.js")).communityRouter,
  "/api/collections": (await import("../src/routes/collections.js")).collectionsRouter,
  "/api/watchlist": (await import("../src/routes/watchlist.js")).watchlistRouter,
  "/api/agents": (await import("../src/routes/agents.js")).agentsRouter,
  "/api/activity": (await import("../src/routes/activity.js")).activityRouter,
  "/api/uploads": (await import("../src/routes/uploads.js")).uploadsRouter,
};

await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
await initDb();

const app = express();
app.set("trust proxy", 1);
app.post("/api/uploads/image", (req, res, next) => { const ct = (req.get("content-type") || "").split(";")[0].trim().toLowerCase(); if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(ct)) return res.status(415).json({ error: "unsupported content type" }); next(); }, express.raw({ type: ["image/png", "image/jpeg", "image/gif", "image/webp"], limit: 5 * 1024 * 1024, verify: (req, res, buf) => { req.rawBody = buf; } }), verifyAgentSignature);
app.use(express.json({ limit: "100kb", verify: (req, res, buf) => { req.rawBody = buf; } }));
for (const [m, p] of [["post", "/api/nfts/prepare-metadata"], ["post", "/api/nfts/:tokenId/community"], ["post", "/api/community/metadata"], ["post", "/api/community/post"], ["post", "/api/collections/:id/profile"], ["post", "/api/watchlist"], ["delete", "/api/watchlist/:id"]]) app[m](p, verifyAgentSignature);
app.get("/ipfs/:cid", (req, res) => { const p = pins.get(req.params.cid); return p ? res.type(p.type).send(p.body) : res.status(404).end(); });
app.get("/health", (req, res) => res.json({ ok: true, environment: "local-test" }));
app.get("/api/contract-info", (req, res) => res.json({
  chainId: 84532, agentRegistryAddress: registry, nftContractAddress: nft, marketplaceContractAddress: market,
  offersContractAddress: offers, communityRegistryAddress: comm, usdcAddress: usdc,
}));
for (const router of Object.values(routers)) {
  for (const layer of router.stack) if (layer.route) for (const l of layer.route.stack) { const fn = l.handle; l.handle = (q, s, n) => Promise.resolve(fn(q, s, n)).catch(n); }
}
for (const [mount, router] of Object.entries(routers)) app.use(mount, router);

const free = (fn) => fn; // x402 is intentionally absent locally
const transports = new Map();
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);
  res.on("close", () => transports.delete(transport.sessionId));
  await createMcpServer({
    paidBrowseListings: free, paidGetNft: free, paidListCommunities: free, paidEstimateFloor: free,
    paidEstimateRarity: free, paidDetectWashTrading: free, paidRegisterAgent: free, paidLinkWallet: free,
  }, { clientIp: req.ip }).connect(transport);
});
app.post("/messages", async (req, res) => {
  const t = transports.get(String(req.query.sessionId ?? ""));
  if (!t) return res.status(400).json({ error: "no session" });
  await t.handlePostMessage(req, res, req.body);
});
app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "invalid JSON body" });
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "request body too large" });
  console.error("[route error]", req.method, req.originalUrl, err.message);
  if (!res.headersSent) res.status(500).json({ error: "internal server error" });
});

app.listen(PORT, async () => {
  await startIndexer();
  console.log(`\nREADY  local OpenEden stack on http://127.0.0.1:${PORT}  (fake USDC, no x402 charges)`);
  console.log(`  funder key for the test scripts (anvil's public key #0, holds 1,000 fake USDC):\n  ${DEPLOYER_KEY}\n`);
});
