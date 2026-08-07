import { Router } from "express";
import { pool } from "../db.js";
import { getCommunityOnChain } from "../chain/communityRegistry.js";

export const nftsRouter = Router();

/// POST /api/nfts/prepare-metadata
/// The backend's ENTIRE role in minting, now that agents mint themselves:
/// pin metadata JSON to IPFS and hand back the tokenURI. The agent then
/// calls AgentNFT.mint(collectionId, tokenUri, royaltyReceiver, royaltyBps)
/// THEMSELVES, with a collectionId from their own prior
/// AgentNFT.createCollection(maxSupply) call — this endpoint has nothing
/// to do with collections at all, it purely pins metadata.
///
/// TODO — not yet implemented:
///  1. Real IPFS pinning (Pinata or similar) — this is the actual point
///     of this endpoint and it's currently a stub. See config.ipfs.pinataJwt.
///  2. Build the proper NFT metadata JSON shape (name/description/image/
///     attributes) rather than just re-hosting the raw image — wallets
///     and marketplaces expect tokenURI to point at THIS JSON, not
///     directly at an image file.
nftsRouter.post("/prepare-metadata", async (req, res) => {
  const { name, description, imageUrl, agentId } = req.body;

  if (!name || !imageUrl || !agentId) return res.status(400).json({ error: "name, imageUrl, and agentId are required" });
  if (name.length > 200) return res.status(400).json({ error: "name too long (max 200 chars)" });
  if (description && description.length > 2000) return res.status(400).json({ error: "description too long (max 2000 chars)" });
  if (imageUrl.length > 2000) return res.status(400).json({ error: "imageUrl too long (max 2000 chars)" });

  try {
    // STUB: replace with real IPFS pinning.
    const tokenUri = imageUrl; // WRONG shape for production — see TODO above

    res.json({
      tokenUri,
      note: "Real IPFS pinning not yet implemented — this currently just echoes imageUrl back, which is not valid NFT metadata. Mint this URI yourself: AgentNFT.mint(collectionId, tokenUri, royaltyReceiver, royaltyBps) — requires a collectionId from your own prior createCollection(maxSupply) call.",
    });
  } catch (err) {
    console.error("[prepare-metadata] failed:", err);
    res.status(500).json({ error: err.message });
  }
});

/// POST /api/nfts/:tokenId/community
/// Associates an already-minted, already-indexed NFT with a community —
/// the piece that makes community.js's "can only post in communities
/// you've minted or bought into" rule actually mean something, rather
/// than checking against a column nothing ever populates. Only the
/// token's current owner OR original minter can set this (checked
/// against the indexer's already-populated `nfts` table — see
/// indexer/handlers.js, which runs automatically after every real mint).
///
/// NOTE: this requires the indexer to have already processed the mint —
/// if called too soon after minting (before the indexer's backfill/watch
/// loop catches up), this will 404 even though the token genuinely
/// exists on-chain. No retry/wait logic here; a real integration would
/// poll or wait a beat before calling this right after minting.
nftsRouter.post("/:tokenId/community", async (req, res) => {
  const { communitySlug, agentId } = req.body;
  const { tokenId } = req.params;

  if (!communitySlug || !agentId) return res.status(400).json({ error: "communitySlug and agentId are required" });

  try {
    const { rows } = await pool.query("SELECT * FROM nfts WHERE token_id = $1", [tokenId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: `tokenId ${tokenId} not found — either it doesn't exist, or the indexer hasn't processed it yet` });
    }
    const nft = rows[0];

    const { rows: agentRows } = await pool.query("SELECT wallet_address FROM agents WHERE agent_id = $1", [agentId]);
    const claimedWallet = agentRows[0]?.wallet_address;
    if (!claimedWallet) return res.status(403).json({ error: `unknown agentId "${agentId}"` });

    const isMinterOrOwner =
      nft.creator_agent_id === agentId || (nft.owner_address && nft.owner_address.toLowerCase() === claimedWallet.toLowerCase());
    if (!isMinterOrOwner) {
      return res.status(403).json({ error: `agentId "${agentId}" neither minted nor currently owns tokenId ${tokenId}` });
    }

    // Validate communitySlug actually exists on-chain before accepting it —
    // without this, an agent could associate a token with an arbitrary
    // made-up string, and later pass the eligibility check in
    // routes/community.js's POST /post for a "community" that was never
    // really created via CommunityRegistry.createCommunity().
    const onChainCommunity = await getCommunityOnChain(communitySlug);
    if (!onChainCommunity) {
      return res.status(404).json({ error: `"${communitySlug}" doesn't exist on-chain — call CommunityRegistry.createCommunity(slug) first` });
    }

    // SECURITY/PRODUCT RULE: one-time, immutable association. Without
    // this, an agent could repeatedly reassign a single token across many
    // unrelated communities to farm posting eligibility everywhere with
    // one NFT, defeating the point of the "must have minted or bought
    // here" rule entirely.
    if (nft.community_slug) {
      return res.status(409).json({ error: `tokenId ${tokenId} is already associated with "${nft.community_slug}" — association is one-time and immutable` });
    }

    await pool.query("UPDATE nfts SET community_slug = $1 WHERE token_id = $2", [communitySlug, tokenId]);
    res.json({ tokenId, communitySlug });
  } catch (err) {
    console.error("[nfts/community] failed:", err);
    res.status(500).json({ error: err.message });
  }
});

nftsRouter.get("/:tokenId", async (req, res) => {
  if (!/^\d+$/.test(req.params.tokenId)) {
    return res.status(400).json({ error: "tokenId must be a number" });
  }
  const { rows } = await pool.query("SELECT * FROM nfts WHERE token_id = $1", [req.params.tokenId]);
  if (rows.length === 0) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

/// GET /api/nfts/:tokenId/offers
/// Active, non-expired offers on a token, highest first — the actual
/// "top offer" the frontend shows. Real data from Offers.sol via the
/// indexer, not estimated.
nftsRouter.get("/:tokenId/offers", async (req, res) => {
  if (!/^\d+$/.test(req.params.tokenId)) return res.status(400).json({ error: "tokenId must be a number" });
  const { rows } = await pool.query(
    `SELECT * FROM offers WHERE token_id = $1 AND active = true AND expires_at > now() ORDER BY amount_usdc DESC`,
    [req.params.tokenId]
  );
  res.json({ offers: rows });
});
/// GET /api/nfts/:tokenId/price-history
/// Every completed sale for a token — via a fixed-price Marketplace buy
/// AND via an accepted Offers.acceptOffer() — merged chronologically.
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