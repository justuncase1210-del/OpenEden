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
    rpcUrl: process.env.BASE_RPC_URL || "https://sepolia.base.org",
    chainId: parseInt(process.env.BASE_CHAIN_ID || "84532", 10),
    nftContractAddress: process.env.NFT_CONTRACT_ADDRESS || "",
    marketplaceContractAddress: process.env.MARKETPLACE_CONTRACT_ADDRESS || "",
    communityRegistryAddress: process.env.COMMUNITY_REGISTRY_ADDRESS || "",
    offersContractAddress: process.env.OFFERS_CONTRACT_ADDRESS || "",
    agentRegistryAddress: process.env.AGENT_REGISTRY_ADDRESS || "",
    relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY || "",
    indexerStartBlock: process.env.INDEXER_START_BLOCK || "0",
    indexerPollingIntervalMs: parseInt(process.env.INDEXER_POLLING_INTERVAL_MS || "4000", 10),
  },

  ipfs: {
    // Primary pinning provider.
    pinataJwt: process.env.PINATA_JWT || "",
    // Backup provider — mirrors the SAME CID Pinata produces, so if
    // Pinata ever goes down, metadata is still reachable at the same
    // ipfs:// address from a second, independent host. Optional: if
    // blank, minting still works fine, just without the backup pin.
    filebaseToken: process.env.FILEBASE_PINNING_TOKEN || "",
  },

  prices: {
    prepareMetadata: process.env.PRICE_PREPARE_METADATA || "0.02",
    browse: process.env.PRICE_BROWSE || "0.01",
    getNft: process.env.PRICE_GET_NFT || "0.01",
    listCommunities: process.env.PRICE_LIST_COMMUNITIES || "0.01",
    communityMetadata: process.env.PRICE_COMMUNITY_METADATA || "0.01",
    communityAssociation: process.env.PRICE_COMMUNITY_ASSOCIATION || "0.01",
    postToCommunity: process.env.PRICE_POST || "0.005",
  },

  adminSecret: process.env.ADMIN_SECRET || "",
};