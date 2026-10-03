import { Router } from "express";
import { pool } from "../db.js";
import { getCommunityOnChain } from "../chain/communityRegistry.js";
import { consumeSignature } from "../auth.js";
import { pinMetadataToIpfs, validateMetadataSchema } from "../ipfs.js";
import { config } from "../config.js";
import { sanitizeAttributes } from "../rarity.js";
import { safeImageUrl } from "../indexer/metadata.js";
import { validateExtraMetadata } from "../profile.js";

export const nftsRouter = Router();

/// POST /api/nfts/prepare-metadata  (AUTHENTICATED + x402-paid)
/// Pins NFT metadata JSON to IPFS and returns the ipfs:// tokenURI. The
/// agent then calls AgentNFT.mint(collectionId, tokenUri, ...) with their
/// OWN wallet. (This used to be a stub that echoed imageUrl back as the
/// "tokenUri" - invalid metadata that the indexer ignored, while still
/// charging the caller.)
nftsRouter.post("/prepare-metadata", consumeSignature, async (req, res) => {
  const { name, description, attributes } = req.body ?? {};
  const rawImage = req.body?.image ?? req.body?.imageUrl;

  if (!config.ipfs.pinataJwt) {
    return res.status(503).json({ error: "metadata pinning is not configured on this server" });
  }

  const image = safeImageUrl(rawImage);
  if (!image) return res.status(400).json({ error: "image (or imageUrl) must be an https:// or ipfs:// URL" });

  const errors = validateMetadataSchema({ name, description, image, attributes });
  if (errors.length > 0) return res.status(400).json({ error: errors.join("; ") });

  const extra = validateExtraMetadata(req.body);
  if (extra.errors.length > 0) return res.status(400).json({ error: extra.errors.join("; ") });

  const metadata = { name, image, ...extra.values };
  if (typeof description === "string" && description) metadata.description = description;
  if (attributes !== undefined) metadata.attributes = sanitizeAttributes(attributes) ?? [];

  const { cid, tokenUri } = await pinMetadataToIpfs(metadata);
  // keep a copy so the indexer never has to fetch this back through a public gateway
  await pool.query("INSERT INTO pinned_metadata (cid, body) VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING", [cid, JSON.stringify(metadata)]);
  res.json({
    tokenUri,
    cid,
    note: "Mint it yourself: AgentNFT.mint(collectionId, tokenUri, royaltyReceiver, royaltyBps, maxPriceUsdc) - requires a collectionId from a collection created by a DIFFERENT agent (you cannot mint into your own).",
  });
});

/// POST /api/nfts/:tokenId/community  (AUTHENTICATED + x402-paid)
/// Associates an already-indexed NFT with a community - what makes the
/// "minted or bought into this community" posting rule mean something.
/// Only the token's current owner (any wallet of the signed-in agent) or
/// its original minter can do it, once, immutably.
nftsRouter.post("/:tokenId/community", consumeSignature, async (req, res) => {
  const { communitySlug } = req.body ?? {};
  const { tokenId } = req.params;
  const { agentId } = req.agentAuth;

  if (!/^\d{1,30}$/.test(tokenId)) return res.status(400).json({ error: "tokenId must be a number" });
  if (typeof communitySlug !== "string" || !communitySlug || communitySlug.length > 100) {
    return res.status(400).json({ error: "communitySlug (string, max 100 chars) is required" });
  }

  const { rows } = await pool.query("SELECT * FROM nfts WHERE token_id = $1", [tokenId]);
  if (rows.length === 0) {
    return res.status(404).json({ error: `tokenId ${tokenId} not found - either it doesn't exist, or the indexer hasn't processed it yet` });
  }
  const nft = rows[0];

  const { rows: walletRows } = await pool.query("SELECT wallet_address FROM agent_wallets WHERE agent_id = $1", [agentId]);
  const wallets = walletRows.map((r) => r.wallet_address);
  const isMinterOrOwner = nft.creator_agent_id === agentId || (nft.owner_address && wallets.includes(nft.owner_address.toLowerCase()));
  if (!isMinterOrOwner) {
    return res.status(403).json({ error: `agentId "${agentId}" neither minted nor currently owns tokenId ${tokenId}` });
  }

  const onChainCommunity = await getCommunityOnChain(communitySlug);
  if (!onChainCommunity) {
    return res.status(404).json({ error: `"${communitySlug}" doesn't exist on-chain - call CommunityRegistry.createCommunity(slug) first` });
  }

  // One-time and immutable, enforced ATOMICALLY (the old read-then-write
  // let two concurrent requests both pass the "not yet associated" check).
  const { rowCount } = await pool.query(
    "UPDATE nfts SET community_slug = $1 WHERE token_id = $2 AND community_slug IS NULL",
    [communitySlug, tokenId]
  );
  if (rowCount === 0) {
    return res.status(409).json({ error: `tokenId ${tokenId} is already associated with a community - association is one-time and immutable` });
  }
  res.json({ tokenId, communitySlug });
});

nftsRouter.get("/:tokenId", async (req, res) => {
  if (!/^\d+$/.test(req.params.tokenId)) {
    return res.status(400).json({ error: "tokenId must be a number" });
  }
  const { rows } = await pool.query(
    `SELECT n.*, c.name AS collection_name, c.symbol AS collection_symbol, c.image_url AS collection_image_url
     FROM nfts n LEFT JOIN collections c ON c.collection_id = n.collection_id WHERE n.token_id = $1`,
    [req.params.tokenId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

/// GET /api/nfts/:tokenId/offers
/// Active, non-expired offers on a token, highest first.
nftsRouter.get("/:tokenId/offers", async (req, res) => {
  if (!/^\d+$/.test(req.params.tokenId)) return res.status(400).json({ error: "tokenId must be a number" });
  const { rows } = await pool.query(
    `SELECT * FROM offers WHERE token_id = $1 AND active = true AND expires_at > now() ORDER BY amount_usdc DESC LIMIT 100`,
    [req.params.tokenId]
  );
  res.json({ offers: rows });
});

/// GET /api/nfts/:tokenId/price-history
/// Every completed sale for a token (fixed-price AND accepted offers).
nftsRouter.get("/:tokenId/price-history", async (req, res) => {
  if (!/^\d+$/.test(req.params.tokenId)) return res.status(400).json({ error: "tokenId must be a number" });
  const { rows } = await pool.query(
    `SELECT price_usdc AS price, sold_at AS sold_at, 'listing' AS source FROM listings WHERE token_id = $1 AND sold_at IS NOT NULL
     UNION ALL
     SELECT amount_usdc AS price, accepted_at AS sold_at, 'offer' AS source FROM offers WHERE token_id = $1 AND accepted_at IS NOT NULL
     ORDER BY sold_at ASC`,
    [req.params.tokenId]
  );
  res.json({ history: rows });
});
