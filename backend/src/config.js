import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/// Tolerates the usual copy-paste slips (surrounding quotes/whitespace, missing
/// 0x) and otherwise fails with a clear message. The key itself is never logged -
/// only its length, which is enough to spot a truncated paste.
function normalizePrivateKey(raw) {
  if (!raw) return "";
  let key = raw.trim().replace(/^["']|["']$/g, "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(key)) key = `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      `RELAYER_PRIVATE_KEY is set but is not a valid private key (expected 0x + 64 hex characters = 66 total; got ${key.length} characters). Re-copy it with no quotes, spaces or line breaks.`
    );
  }
  return key;
}

export const config = {
  port: parseInt(process.env.PORT || "4022", 10),

  // How many reverse-proxy hops sit in front of this server (Render = 1).
  // WITHOUT this, every request appears to come from the proxy's IP, so
  // express-rate-limit would put ALL users in one bucket. Set to "0" only
  // when running with no proxy at all (local dev).
  trustProxy: /^\d+$/.test(process.env.TRUST_PROXY ?? "1") ? parseInt(process.env.TRUST_PROXY ?? "1", 10) : process.env.TRUST_PROXY,

  cors: {
    // Optional regex (full-match) for origins that change on every deploy,
    // e.g. Vercel preview URLs: my-app-[a-z0-9]+-myteam\.vercel\.app
    // Matched against the host only, https only. Leave empty to disable.
    originPattern: process.env.ALLOWED_ORIGIN_PATTERN || "",
    allowedOrigins: (process.env.ALLOWED_ORIGINS || "http://localhost:3000").split(",").map((s) => s.trim()),
  },

  x402: {
    environment: process.env.CDP_X402_SERVER_ENVIRONMENT || "development",
    payToAddress: process.env.X402_PAY_TO_ADDRESS || "",
  },

  db: {
    url: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/ai_nft_marketplace",
    // Certificate verification is ON by default. Only set this to "true"
    // for a provider that serves a self-signed cert you can't pin.
    sslInsecure: process.env.DATABASE_SSL_INSECURE === "true",
  },

  chain: {
    rpcUrl: process.env.BASE_RPC_URL || "https://sepolia.base.org",
    chainId: parseInt(process.env.BASE_CHAIN_ID || "84532", 10),
    nftContractAddress: process.env.NFT_CONTRACT_ADDRESS || "",
    marketplaceContractAddress: process.env.MARKETPLACE_CONTRACT_ADDRESS || "",
    communityRegistryAddress: process.env.COMMUNITY_REGISTRY_ADDRESS || "",
    offersContractAddress: process.env.OFFERS_CONTRACT_ADDRESS || "",
    agentRegistryAddress: process.env.AGENT_REGISTRY_ADDRESS || "",
    // Official USDC for the configured chain (override with USDC_ADDRESS).
    usdcAddress:
      process.env.USDC_ADDRESS ||
      (parseInt(process.env.BASE_CHAIN_ID || "84532", 10) === 8453
        ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
        : "0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
    // Only index blocks this many confirmations deep (cheap reorg defense).
    indexerConfirmations: parseInt(process.env.INDEXER_CONFIRMATIONS || "2", 10),
    relayerPrivateKey: normalizePrivateKey(process.env.RELAYER_PRIVATE_KEY),
    indexerStartBlock: process.env.INDEXER_START_BLOCK || "0",
    indexerPollingIntervalMs: parseInt(process.env.INDEXER_POLLING_INTERVAL_MS || "4000", 10),
    indexerChunkSize: process.env.INDEXER_CHUNK_SIZE || "900",
    indexerChunkDelayMs: process.env.INDEXER_CHUNK_DELAY_MS || "0",
  },

  ipfs: {
    gateways: (process.env.IPFS_GATEWAYS || "https://ipfs.io/ipfs/,https://cloudflare-ipfs.com/ipfs/,https://dweb.link/ipfs/")
      .split(",").map((s) => s.trim()).filter(Boolean),
    pinataJwt: process.env.PINATA_JWT || "",
    filebaseToken: process.env.FILEBASE_PINNING_TOKEN || "",
  },

  // Sybil / gas-drain defense for the (otherwise free) register_agent tool.
  // registerAgent is an x402 charge in USDC - set PRICE_REGISTER_AGENT=0 to
  // make it free again (then rely on the per-IP cap below).
  registration: {
    perIpPerHour: parseInt(process.env.REGISTRATIONS_PER_IP_PER_HOUR || "5", 10),
  },

  sse: {
    maxConnections: parseInt(process.env.SSE_MAX_CONNECTIONS || "200", 10),
    maxPerIp: parseInt(process.env.SSE_MAX_PER_IP || "5", 10),
    maxLifetimeMs: parseInt(process.env.SSE_MAX_LIFETIME_MS || String(30 * 60_000), 10),
  },

  prices: {
    registerAgent: process.env.PRICE_REGISTER_AGENT || "0.05",
    // link_wallet makes the relayer send an on-chain registerAgent transaction (gas), so it is paid too.
    linkWallet: process.env.PRICE_LINK_WALLET || "0.02",
    prepareMetadata: process.env.PRICE_PREPARE_METADATA || "0.02",
    browse: process.env.PRICE_BROWSE || "0.01",
    getNft: process.env.PRICE_GET_NFT || "0.01",
    listCommunities: process.env.PRICE_LIST_COMMUNITIES || "0.01",
    communityMetadata: process.env.PRICE_COMMUNITY_METADATA || "0.01",
    communityAssociation: process.env.PRICE_COMMUNITY_ASSOCIATION || "0.01",
    postToCommunity: process.env.PRICE_POST || "0.005",
    collectionProfile: process.env.PRICE_COLLECTION_PROFILE || "0.01",
    uploadImage: process.env.PRICE_UPLOAD_IMAGE || "0.02",
  },

  // Per-agent upload quota (rolling 24h) - bounds how much anyone can make us pin.
  uploads: {
    // OFF by default: uploads are pinned in the operator's own Pinata account, so they cost the
    // operator money. Agents can supply any https:// image URL, or pin an ipfs:// image themselves.
    enabled: process.env.ENABLE_IMAGE_UPLOAD === "true",
    maxPerDay: parseInt(process.env.UPLOADS_MAX_PER_DAY || "20", 10),
    maxBytesPerDay: parseInt(process.env.UPLOADS_MAX_BYTES_PER_DAY || String(50 * 1024 * 1024), 10),
  },

  // Platform-level ERC-7572 contractURI document (served at GET /api/contract-metadata).
  platform: {
    name: process.env.PLATFORM_NAME || "OpenEden Agent NFTs",
    description: process.env.PLATFORM_DESCRIPTION || "NFTs minted, collected and traded by autonomous AI agents on Base.",
    imageUrl: process.env.PLATFORM_IMAGE_URL || "",
    siteUrl: process.env.SITE_URL || "",
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