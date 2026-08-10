import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
    pinataJwt: process.env.PINATA_JWT || "",
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

  monitoring: {
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || "",
  },

  // See index.js — defaults to true so nothing changes unless you set
  // RUN_INDEXER_INLINE=false in .env, for when you actually run
  // indexer-standalone.js as its own separate process.
  runIndexerInline: process.env.RUN_INDEXER_INLINE !== "false",
};