import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isAddress, verifyMessage } from "viem";
import { pool } from "../db.js";
import { nanoid } from "nanoid";
import { registerAgentOnChain } from "../chain/agentRegistry.js";
import { buildRegistrationMessage, REGISTRATION_SIGNATURE_MAX_AGE_MS } from "./registrationMessage.js";
import { config } from "../config.js";

export function createMcpServer({
  paidBrowseListings,
  paidGetNft,
  paidListCommunities,
  paidEstimateFloor,
  paidEstimateRarity,
  paidDetectWashTrading,
}) {
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
    async ({ name, walletAddress, description, timestamp, signature }) => {
      const age = Date.now() - timestamp;
      if (age < 0 || age > REGISTRATION_SIGNATURE_MAX_AGE_MS) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `timestamp is stale or in the future (must be signed within the last ${REGISTRATION_SIGNATURE_MAX_AGE_MS / 1000}s)`,
            }),
          }],
        };
      }

      const message = buildRegistrationMessage({ walletAddress, timestamp });
      const validSignature = await verifyMessage({ address: walletAddress, message, signature }).catch(() => false);
      if (!validSignature) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "signature verification failed — sign the exact message from get_contract_info's registrationMessageFormat with the private key for walletAddress",
            }),
          }],
        };
      }

      const agentId = nanoid(12);

      await pool.query(
        `INSERT INTO agents (agent_id, name, wallet_address, description) VALUES ($1, $2, $3, $4)`,
        [agentId, name, walletAddress, description || null]
      );

      try {
        const result = await registerAgentOnChain({ wallet: walletAddress, agentId });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              agentId,
              name,
              walletAddress,
              onChainRegistration: result.alreadyRegistered
                ? { success: true, note: "wallet was already registered on-chain — no new transaction needed" }
                : { success: true, transactionHash: result.transactionHash },
            }),
          }],
        };
      } catch (err) {
        console.error("[register_agent] on-chain registration failed:", err);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              agentId,
              name,
              walletAddress,
              onChainRegistration: { success: false, error: err.message },
              warning: "Agent record created in the database, but on-chain wallet allowlisting FAILED. You will NOT be able to list, buy, create communities, or join communities until this is resolved — those calls will revert with NotAgent(). Contact the marketplace operator or retry registration.",
            }),
          }],
        };
      }
    }
  );

  server.tool(
    "link_wallet",
    "Register an ADDITIONAL wallet under your EXISTING agentId (rather than creating a brand new identity). Requires the same wallet-ownership signature proof as register_agent, signed by the NEW wallet. Free — no payment required. IMPORTANT LIMITATION: on-chain rate limits (collection creation, list+buy, mint cooldown) are tracked PER WALLET, not per agentId — linking a second wallet does NOT share or pool those limits with your first wallet.",
    {
      agentId: z.string(),
      newWalletAddress: z.string().refine(isAddress, { message: "must be a valid checksummed EVM address" }),
      timestamp: z.number().int(),
      signature: z.string(),
    },
    async ({ agentId, newWalletAddress, timestamp, signature }) => {
      const { rows } = await pool.query("SELECT 1 FROM agents WHERE agent_id = $1", [agentId]);
      if (rows.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `unknown agentId "${agentId}" — register first via register_agent` }) }] };
      }

      const age = Date.now() - timestamp;
      if (age < 0 || age > REGISTRATION_SIGNATURE_MAX_AGE_MS) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: `timestamp is stale or in the future (must be signed within the last ${REGISTRATION_SIGNATURE_MAX_AGE_MS / 1000}s)` }),
          }],
        };
      }

      const message = buildRegistrationMessage({ walletAddress: newWalletAddress, timestamp });
      const validSignature = await verifyMessage({ address: newWalletAddress, message, signature }).catch(() => false);
      if (!validSignature) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "signature verification failed — sign the same message format register_agent uses, but with the NEW wallet's key" }) }] };
      }

      try {
        const result = await registerAgentOnChain({ wallet: newWalletAddress, agentId });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              agentId,
              newWalletAddress,
              onChainRegistration: result.alreadyRegistered
                ? { success: true, note: "wallet was already registered on-chain" }
                : { success: true, transactionHash: result.transactionHash },
              warning: "Rate limits (collections/week, daily list+buy, mint cooldown) remain PER WALLET — this new wallet starts with its own fresh limits, not shared with your other wallet.",
            }),
          }],
        };
      } catch (err) {
        console.error("[link_wallet] on-chain registration failed:", err);
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
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
    { tokenId: z.string().max(78) },
    paidEstimateRarity(async ({ tokenId }) => {
      const { rows: tokenRows } = await pool.query("SELECT collection_id, attributes FROM nfts WHERE token_id = $1", [tokenId]);
      if (tokenRows.length === 0) return { content: [{ type: "text", text: JSON.stringify({ error: "token not found" }) }] };
      const collectionId = tokenRows[0].collection_id;

      const { rows } = await pool.query(
        "SELECT token_id, attributes FROM nfts WHERE collection_id = $1 AND attributes IS NOT NULL",
        [collectionId]
      );
      if (rows.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ tokenId, error: "no tokens in this collection have stored attributes — nothing to rank against" }) }] };
      }

      const traitCounts = {};
      for (const row of rows) {
        for (const attr of row.attributes || []) {
          traitCounts[attr.trait_type] ??= {};
          traitCounts[attr.trait_type][attr.value] = (traitCounts[attr.trait_type][attr.value] || 0) + 1;
        }
      }

      const totalTokens = rows.length;
      const scored = rows.map((row) => {
        let score = 0;
        for (const attr of row.attributes || []) {
          const frequency = traitCounts[attr.trait_type][attr.value] / totalTokens;
          score += 1 / frequency;
        }
        return { tokenId: row.token_id, rarityScore: Math.round(score * 100) / 100 };
      });
      scored.sort((a, b) => b.rarityScore - a.rarityScore);

      const rank = scored.findIndex((s) => s.tokenId === tokenId) + 1;
      const entry = scored.find((s) => s.tokenId === tokenId);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ tokenId, collectionId, rarityScore: entry?.rarityScore ?? null, rank: rank || null, outOf: totalTokens }),
        }],
      };
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