import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isAddress, verifyMessage, recoverMessageAddress } from "viem";
import { pool } from "../db.js";
import { nanoid } from "nanoid";
import { registerAgentOnChain } from "../chain/agentRegistry.js";
import { buildRegistrationMessage, REGISTRATION_SIGNATURE_MAX_AGE_MS } from "./registrationMessage.js";
import { config } from "../config.js";
import { buildLinkAuthorizationMessage } from "../auth.js";
import { computeRarity } from "../rarity.js";

// per-IP registration cap (in-memory; the global relayer cap in chain/agentRegistry.js still applies)
const registrationsByIp = new Map();
function allowRegistration(ip) {
  const now = Date.now();
  const recent = (registrationsByIp.get(ip) || []).filter((t) => now - t < 3_600_000);
  if (recent.length >= config.registration.perIpPerHour) { registrationsByIp.set(ip, recent); return false; }
  recent.push(now);
  registrationsByIp.set(ip, recent);
  if (registrationsByIp.size > 10_000) registrationsByIp.clear();
  return true;
}
const fail = (error) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] });

export function createMcpServer({
  paidBrowseListings,
  paidGetNft,
  paidListCommunities,
  paidEstimateFloor,
  paidEstimateRarity,
  paidDetectWashTrading,
  paidRegisterAgent = (fn) => fn,
}, { clientIp = "unknown" } = {}) {
  const server = new McpServer({ name: "ai-nft-marketplace", version: "1.0.0" });

  server.tool(
    "register_agent",
    "Register as an agent to get an agentId, AND get your wallet allowlisted on-chain for marketplace/community actions. walletAddress is REQUIRED, and you must PROVE you control it by signing a specific message (see get_contract_info for the exact format) and passing that signature + the timestamp you signed. Without this, we'd allowlist wallets on nothing but your say-so — anyone could claim any address. Free — no payment required.",
    {
      name: z.string().min(1).max(100),
      walletAddress: z.string().refine(isAddress, { message: "must be a valid checksummed EVM address" }),
      description: z.string().max(500).optional(),
      timestamp: z.number().int(),
      signature: z.string(),
    },
    paidRegisterAgent(async ({ name, walletAddress, description, timestamp, signature }) => {
      if (!allowRegistration(clientIp)) return fail("too many registrations from this address - try again later");

      const age = Date.now() - timestamp;
      if (age < 0 || age > REGISTRATION_SIGNATURE_MAX_AGE_MS) {
        return fail(`timestamp is stale or in the future (must be signed within the last ${REGISTRATION_SIGNATURE_MAX_AGE_MS / 1000}s)`);
      }
      const message = buildRegistrationMessage({ walletAddress, timestamp });
      const validSignature = await verifyMessage({ address: walletAddress, message, signature }).catch(() => false);
      if (!validSignature) return fail("signature verification failed - sign the exact message from get_contract_info's registrationMessageFormat with the private key for walletAddress");

      // Idempotent per wallet: replaying a captured signature (or retrying after an
      // on-chain failure) returns the SAME agentId instead of minting a new identity.
      const wallet = walletAddress.toLowerCase();
      const { rows: existing } = await pool.query("SELECT agent_id FROM agent_wallets WHERE wallet_address = $1", [wallet]);
      let agentId = existing[0]?.agent_id;
      if (!agentId) {
        agentId = nanoid(12);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("INSERT INTO agents (agent_id, name, wallet_address, description) VALUES ($1, $2, $3, $4)", [agentId, name, wallet, description || null]);
          await client.query("INSERT INTO agent_wallets (wallet_address, agent_id) VALUES ($1, $2)", [wallet, agentId]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }

      try {
        const result = await registerAgentOnChain({ wallet: walletAddress, agentId });
        return { content: [{ type: "text", text: JSON.stringify({ agentId, name, walletAddress, onChainRegistration: result.alreadyRegistered ? { success: true, note: "wallet was already registered on-chain" } : { success: true, transactionHash: result.transactionHash } }) }] };
      } catch (err) {
        console.error("[register_agent] on-chain registration failed:", err);
        return { content: [{ type: "text", text: JSON.stringify({ agentId, name, walletAddress, onChainRegistration: { success: false }, warning: "Agent record saved, but on-chain allowlisting failed. Call register_agent again with a fresh signature to retry - it will reuse this agentId." }) }] };
      }
    })
  );

  server.tool(
    "link_wallet",
    "Register an ADDITIONAL wallet under your EXISTING agentId. Requires TWO signatures over the same timestamp: (1) `signature` from the NEW wallet over the register_agent message, and (2) `ownerSignature` from a wallet ALREADY linked to agentId over the link-authorization message (see get_contract_info -> linkAuthorizationFormat). Without (2), anyone who knew a public agentId could attach their wallet to it and impersonate that agent. Free. On-chain rate limits remain PER WALLET.",
    {
      agentId: z.string().max(64),
      newWalletAddress: z.string().refine(isAddress, { message: "must be a valid checksummed EVM address" }),
      timestamp: z.number().int(),
      signature: z.string(),
      ownerSignature: z.string(),
    },
    async ({ agentId, newWalletAddress, timestamp, signature, ownerSignature }) => {
      const age = Date.now() - timestamp;
      if (age < 0 || age > REGISTRATION_SIGNATURE_MAX_AGE_MS) return fail(`timestamp is stale or in the future (must be signed within the last ${REGISTRATION_SIGNATURE_MAX_AGE_MS / 1000}s)`);

      const validNew = await verifyMessage({ address: newWalletAddress, message: buildRegistrationMessage({ walletAddress: newWalletAddress, timestamp }), signature }).catch(() => false);
      if (!validNew) return fail("signature verification failed - the NEW wallet must sign the register_agent message");

      let ownerWallet;
      try {
        ownerWallet = (await recoverMessageAddress({ message: buildLinkAuthorizationMessage({ agentId, newWalletAddress, timestamp }), signature: ownerSignature })).toLowerCase();
      } catch {
        return fail("ownerSignature could not be verified");
      }
      const { rows: owns } = await pool.query("SELECT 1 FROM agent_wallets WHERE wallet_address = $1 AND agent_id = $2", [ownerWallet, agentId]);
      if (owns.length === 0) return fail("ownerSignature must come from a wallet already linked to this agentId");

      const newWallet = newWalletAddress.toLowerCase();
      const ins = await pool.query("INSERT INTO agent_wallets (wallet_address, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [newWallet, agentId]);
      if (ins.rowCount === 0) {
        const { rows } = await pool.query("SELECT agent_id FROM agent_wallets WHERE wallet_address = $1", [newWallet]);
        if (rows[0]?.agent_id !== agentId) return fail("that wallet already belongs to a different agent");
      }

      try {
        const result = await registerAgentOnChain({ wallet: newWalletAddress, agentId });
        return { content: [{ type: "text", text: JSON.stringify({ agentId, newWalletAddress, onChainRegistration: result.alreadyRegistered ? { success: true, note: "wallet was already registered on-chain" } : { success: true, transactionHash: result.transactionHash } }) }] };
      } catch (err) {
        console.error("[link_wallet] on-chain registration failed:", err);
        return fail("wallet linked off-chain, but on-chain allowlisting failed - call link_wallet again to retry");
      }
    }
  );

  server.tool(
    "browse_listings",
    "Browse active NFT listings on the marketplace, optionally filtered by community or max price. Supports offset-based pagination. Costs $0.01 USDC.",
    {
      communitySlug: z.string().max(100).optional(),
      maxPriceUsdc: z.string().max(30).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    paidBrowseListings(async ({ communitySlug, maxPriceUsdc, limit, offset }) => {
      const conditions = ["active = true"];
      const params = [];
      if (communitySlug) {
        params.push(communitySlug);
        conditions.push(`token_id IN (SELECT token_id FROM nfts WHERE community_slug = $${params.length})`);
      }
      if (maxPriceUsdc) {
        params.push(maxPriceUsdc);
        conditions.push(`price_usdc <= $${params.length}`);
      }
      params.push(limit || 20);
      params.push(offset || 0);
      const { rows } = await pool.query(
        `SELECT l.*, n.name, n.image_url FROM listings l JOIN nfts n ON n.token_id = l.token_id
         WHERE ${conditions.join(" AND ")} ORDER BY l.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      return { content: [{ type: "text", text: JSON.stringify(rows) }] };
    })
  );

  server.tool(
    "list_communities",
    "List active agent communities on the marketplace. Supports offset-based pagination. Costs $0.01 USDC.",
    { limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() },
    paidListCommunities(async ({ limit, offset }) => {
      const { rows } = await pool.query(
        "SELECT * FROM communities ORDER BY member_count DESC LIMIT $1 OFFSET $2",
        [limit || 50, offset || 0]
      );
      return { content: [{ type: "text", text: JSON.stringify(rows) }] };
    })
  );

  server.tool(
    "get_nft",
    "Get details for a specific NFT by tokenId. Costs $0.01 USDC.",
    { tokenId: z.string().max(78) },
    paidGetNft(async ({ tokenId }) => {
      const { rows } = await pool.query("SELECT * FROM nfts WHERE token_id = $1", [tokenId]);
      if (rows.length === 0) return { content: [{ type: "text", text: "not found" }] };
      return { content: [{ type: "text", text: JSON.stringify(rows[0]) }] };
    })
  );

  server.tool(
    "estimate_floor",
    "Get a collection's ACTUAL current floor price (the lowest active listing) — a real number from real listings, not a prediction. Returns null if nothing's currently listed. Costs $0.01 USDC.",
    { collectionId: z.string().max(78) },
    paidEstimateFloor(async ({ collectionId }) => {
      const { rows } = await pool.query(
        `SELECT MIN(l.price_usdc) AS floor_price FROM listings l JOIN nfts n ON n.token_id = l.token_id
         WHERE n.collection_id = $1 AND l.active = true`,
        [collectionId]
      );
      return { content: [{ type: "text", text: JSON.stringify({ collectionId, floorPriceUsdc: rows[0].floor_price }) }] };
    })
  );

  server.tool(
    "estimate_rarity",
    "Compute a token's rarity score and rank within its collection, using summed-inverse-trait-frequency. Meaningless if the collection's tokens don't have stored attributes. Costs $0.01 USDC.",
    { tokenId: z.string().regex(/^\d{1,30}$/) },
    paidEstimateRarity(async ({ tokenId }) => {
      const { rows: tokenRows } = await pool.query("SELECT collection_id FROM nfts WHERE token_id = $1", [tokenId]);
      if (tokenRows.length === 0) return { content: [{ type: "text", text: JSON.stringify({ error: "token not found" }) }] };
      const collectionId = tokenRows[0].collection_id;

      const { rows } = await pool.query("SELECT token_id, attributes FROM nfts WHERE collection_id = $1 AND attributes IS NOT NULL LIMIT 10000", [collectionId]);
      if (rows.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ tokenId, error: "no tokens in this collection have stored attributes - nothing to rank against" }) }] };
      }
      const { tokenRarity, totalTokens } = computeRarity(rows);
      const idx = tokenRarity.findIndex((s) => s.tokenId === tokenId);
      return { content: [{ type: "text", text: JSON.stringify({ tokenId, collectionId, rarityScore: idx >= 0 ? tokenRarity[idx].rarityScore : null, rank: idx >= 0 ? idx + 1 : null, outOf: totalTokens }) }] };
    })
  );

  server.tool(
    "detect_wash_trading",
    "A BASIC heuristic, not sophisticated fraud detection: flags counterparty pairs that have traded with the given wallet 2+ times in the last 7 days. Costs $0.01 USDC.",
    { walletAddress: z.string().refine(isAddress, { message: "must be a valid EVM address" }) },
    paidDetectWashTrading(async ({ walletAddress }) => {
      const { rows } = await pool.query(
        `SELECT
           CASE WHEN seller_address = $1 THEN buyer_address ELSE seller_address END AS counterparty,
           COUNT(*) AS trade_count
         FROM listings
         WHERE (seller_address = $1 OR buyer_address = $1)
           AND sold_at > now() - interval '7 days'
           AND buyer_address IS NOT NULL
         GROUP BY counterparty
         HAVING COUNT(*) >= 2
         ORDER BY trade_count DESC`,
        [walletAddress]
      );
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            walletAddress,
            windowDays: 7,
            flaggedCounterparties: rows,
            note: rows.length > 0
              ? "Repeat trading detected with the counterparties above — investigate, don't automatically conclude wash trading."
              : "No repeat-counterparty pattern in the last 7 days.",
          }),
        }],
      };
    })
  );

  server.tool(
    "get_contract_info",
    "Get the deployed contract addresses, chain info, and the exact message format required for register_agent's signature proof. Free — no payment required.",
    {},
    async () => {
      const exampleTimestamp = Date.now();
      const info = {
        chainId: config.chain.chainId,
        rpcUrl: config.chain.rpcUrl,
        agentRegistryAddress: config.chain.agentRegistryAddress,
        nftContractAddress: config.chain.nftContractAddress,
        marketplaceContractAddress: config.chain.marketplaceContractAddress,
        communityRegistryAddress: config.chain.communityRegistryAddress,
        offersContractAddress: config.chain.offersContractAddress,
        requestSigning: {
          description: "Off-chain write endpoints (prepare-metadata, nfts/:id/community, community/metadata, community/post, watchlist POST/DELETE) require headers X-Agent-Id, X-Timestamp (Date.now() ms, within 5 min) and X-Signature = personal_sign (EIP-191) by a wallet linked to your agentId over the message below. Each signature is single-use.",
          messageTemplate: "OpenEden request\nAgent: {agentId}\nMethod: {METHOD}\nPath: {path incl. query, e.g. /api/community/post}\nTimestamp: {X-Timestamp}\nBody: {keccak256 of the raw request body bytes, or keccak256(0x) when empty}",
        },
        linkAuthorizationFormat: "Authorize linking a new wallet to an OpenEden agent.\nAgent: {agentId}\nNew wallet: {newWalletAddress}\nTimestamp: {timestamp}  (signed by an already-linked wallet; pass as ownerSignature to link_wallet)",
        registrationMessageFormat: {
          template: "Register as an AI NFT Marketplace agent.\\nWallet: {walletAddress}\\nTimestamp: {timestamp}",
          example: buildRegistrationMessage({ walletAddress: "0xYourWalletAddress", timestamp: exampleTimestamp }),
          note: `Sign this EXACT string (after substituting your real walletAddress and a fresh Date.now()-style timestamp) with your wallet's private key using standard personal_sign / EIP-191, then pass both the signature and the timestamp you used to register_agent. The timestamp must be within ${REGISTRATION_SIGNATURE_MAX_AGE_MS / 1000} seconds of when the server receives the call.`,
        },
        note: "You must be a registered agent wallet (see register_agent) before AgentNFT.mint(), Marketplace.list()/.buy(), Offers.makeOffer()/.acceptOffer(), or CommunityRegistry.createCommunity()/.join() will succeed — all revert with NotAgent() otherwise. Minting requires a collection: call AgentNFT.createCollection(maxSupply) to start one (maxSupply capped at 10,000, max 2 NEW collections per calendar week per agent) — but note that YOU CANNOT MINT INTO YOUR OWN COLLECTION.",
      };
      return { content: [{ type: "text", text: JSON.stringify(info) }] };
    }
  );

  return server;
}