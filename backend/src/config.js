import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Same lesson as the last project: dotenv only auto-finds .env in the
// process's cwd, which breaks if you `cd backend && npm run dev` from
// elsewhere. Resolve explicitly relative to this file instead.
dotenv.config({ path: path.resolve(__dirname, "../.env") });

export const config = {
  port: parseInt(process.env.PORT || "4022", 10),

  cors: {
    // SECURITY: previously wide open (cors() with no origin restriction).
    // Note that CORS only constrains BROWSER-based cross-origin requests —
    // it does nothing to restrict server-to-server callers (agents using
    // viem/node-based MCP or HTTP clients don't send an Origin header and
    // aren't subject to CORS enforcement at all, since that's a browser
    // behavior, not a server one). So restricting this protects against
    // a malicious WEBSITE trying to ride a visitor's browser session to
    // hit this API — it does not, and cannot, restrict non-browser agent
    // traffic. Comma-separated list; defaults to the frontend's typical
    // local dev port.
    allowedOrigins: (process.env.ALLOWED_ORIGINS || "http://localhost:3000").split(",").map((s) => s.trim()),
  },

  x402: {
    environment: process.env.CDP_X402_SERVER_ENVIRONMENT || "development",
    payToAddress: process.env.X402_PAY_TO_ADDRESS || "",
  },

  db: {
    url: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/ai_nft_marketplace",
  },

  chain: {
    // Default to Base Sepolia. Switch to Base mainnet RPC + chain ID 8453
    // deliberately, same production-safety-banner instinct as before —
    // don't let a copy-pasted mainnet RPC URL end up in local dev by accident.
    rpcUrl: process.env.BASE_RPC_URL || "https://sepolia.base.org",
    chainId: parseInt(process.env.BASE_CHAIN_ID || "84532", 10), // 84532 = Base Sepolia, 8453 = Base mainnet
    nftContractAddress: process.env.NFT_CONTRACT_ADDRESS || "",
    marketplaceContractAddress: process.env.MARKETPLACE_CONTRACT_ADDRESS || "",
    communityRegistryAddress: process.env.COMMUNITY_REGISTRY_ADDRESS || "",
    offersContractAddress: process.env.OFFERS_CONTRACT_ADDRESS || "",
    agentRegistryAddress: process.env.AGENT_REGISTRY_ADDRESS || "",
    // The backend's own wallet, used ONLY to call AgentRegistry.
    // registerAgent() when an agent registers. It is NOT used for minting,
    // listing, buying, or creating communities anymore — agents sign all
    // of those themselves with their own wallets. IMPORTANT: this key
    // must be AgentRegistry's owner (see contracts/script/Deploy.s.sol's
    // post-deploy note) — if it isn't, every registerAgent call will
    // revert and NO agent will ever pass the onlyAgent gate anywhere in
    // the system, silently breaking everything downstream.
    relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY || "",

    // Indexer: where to start backfilling from. Set this to the block
    // number your contracts were actually deployed at (Deploy.s.sol's
    // console output includes tx receipts you can look up on Basescan
    // for the exact block) — defaulting to 0 works but means backfill
    // walks the ENTIRE chain history from genesis, which is slow and
    // pointless for a contract that didn't exist yet. Always set this
    // explicitly in any real deployment.
    indexerStartBlock: process.env.INDEXER_START_BLOCK || "0",
    indexerPollingIntervalMs: parseInt(process.env.INDEXER_POLLING_INTERVAL_MS || "4000", 10),
  },

  ipfs: {
    // Metadata pinning — pick one. Pinata's the path of least resistance.
    pinataJwt: process.env.PINATA_JWT || "",
  },
  // Admin-only actions (currently: verifying a collection). Genuinely
  // minimal auth — a single shared secret compared against a header, not
  // a real user/role system. Fine for one operator (you) running this
  // locally; not something to build a multi-admin system on top of
  // without upgrading it first.
  adminSecret: process.env.ADMIN_SECRET || "",

  prices: {
    prepareMetadata: process.env.PRICE_PREPARE_METADATA || "0.02", // IPFS pinning cost, no longer a full "mint" fee — actual minting is agent-signed, no backend fee applies to it
    browse: process.env.PRICE_BROWSE || "0.01",
    getNft: process.env.PRICE_GET_NFT || "0.01",
    listCommunities: process.env.PRICE_LIST_COMMUNITIES || "0.01",
    communityMetadata: process.env.PRICE_COMMUNITY_METADATA || "0.01",
    communityAssociation: process.env.PRICE_COMMUNITY_ASSOCIATION || "0.01",
    postToCommunity: process.env.PRICE_POST || "0.005",
  },
};
