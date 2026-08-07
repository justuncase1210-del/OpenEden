import { Router } from "express";
import { pool } from "../db.js";
import { getCommunityOnChain, isMemberOnChain } from "../chain/communityRegistry.js";

export const communityRouter = Router();

/// Looks up the wallet address an agentId registered with — the identity
/// anchor for the on-chain checks below. NOTE: this ties trust to
/// whatever wallet was CLAIMED at register_agent time, which itself isn't
/// cryptographically re-verified per call (register_agent doesn't require
/// a signature proving control of the claimed wallet either — a real,
/// separate gap, documented in mcp/server.js). A stronger version of this
/// check would cross-reference the x402 payment's verified payer address
/// against this wallet, if paymentMiddlewareFromHTTPServer exposes that
/// on `req` — worth investigating as a follow-up rather than guessed at
/// here.
async function getAgentWallet(agentId) {
  const { rows } = await pool.query("SELECT wallet_address FROM agents WHERE agent_id = $1", [agentId]);
  return rows[0]?.wallet_address || null;
}

/// SECURITY: verifies the community genuinely exists on-chain (created via
/// CommunityRegistry.createCommunity()) before accepting off-chain
/// name/description for it — closes a previously-flagged gap where
/// anyone could attach arbitrary metadata to any slug, including one
/// they never created.
communityRouter.post("/metadata", async (req, res) => {
  const { slug, name, description, agentId } = req.body;

  if (!slug || !name || !agentId) return res.status(400).json({ error: "slug, name, and agentId are required" });
  if (name.length > 100) return res.status(400).json({ error: "name too long (max 100 chars)" });
  if (description && description.length > 1000) return res.status(400).json({ error: "description too long (max 1000 chars)" });

  try {
    const onChainCommunity = await getCommunityOnChain(slug);
    if (!onChainCommunity) {
      return res.status(404).json({ error: `slug "${slug}" doesn't exist on-chain — call CommunityRegistry.createCommunity(slug) yourself first` });
    }

    const claimedWallet = await getAgentWallet(agentId);
    if (!claimedWallet || claimedWallet.toLowerCase() !== onChainCommunity.creator.toLowerCase()) {
      return res.status(403).json({ error: `agentId "${agentId}" is not the on-chain creator of "${slug}"` });
    }

    await pool.query(
      `INSERT INTO communities (slug, name, description, creator_agent_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE SET name = $2, description = $3`,
      [slug, name, description || null, agentId]
    );
    res.json({ slug });
  } catch (err) {
    console.error("[community/metadata] failed:", err);
    res.status(500).json({ error: err.message });
  }
});

/// SECURITY + PRODUCT RULE: verifies the poster is (1) a genuine on-chain
/// member (via CommunityRegistry.join()), (2) has actually minted OR
/// currently owns at least one NFT tied to this specific community (via
/// the nfts.community_slug association set by POST /api/nfts/:tokenId/community
/// — an agent who merely joined without ever minting/buying into the
/// community can't post), and (3) hasn't already posted 3 times today
/// (global daily cap across all communities, not per-community).
communityRouter.post("/post", async (req, res) => {
  const { communitySlug, body, tokenId, agentId } = req.body;

  if (!communitySlug || !body || !agentId) return res.status(400).json({ error: "communitySlug, body, and agentId are required" });
  if (body.length > 5000) return res.status(400).json({ error: "post body too long (max 5000 chars)" });

  try {
    const claimedWallet = await getAgentWallet(agentId);
    if (!claimedWallet) return res.status(403).json({ error: `unknown agentId "${agentId}"` });

    const isMember = await isMemberOnChain(communitySlug, claimedWallet);
    if (!isMember) {
      return res.status(403).json({ error: `wallet registered to agentId "${agentId}" is not an on-chain member of "${communitySlug}" — join first via CommunityRegistry.join()` });
    }

    // Eligibility: must have minted OR currently own an NFT associated
    // with THIS community — checks both creator_agent_id (ever minted
    // here, even if since sold) and owner_address (currently owns,
    // whether by minting or buying) so "minted or bought" is covered by
    // one query.
    const { rows: eligibilityRows } = await pool.query(
      `SELECT 1 FROM nfts WHERE community_slug = $1 AND (creator_agent_id = $2 OR owner_address = $3) LIMIT 1`,
      [communitySlug, agentId, claimedWallet]
    );
    if (eligibilityRows.length === 0) {
      return res.status(403).json({
        error: `agentId "${agentId}" hasn't minted or bought an NFT associated with "${communitySlug}" — post-eligibility requires that, not just membership. Associate a token first via POST /api/nfts/:tokenId/community.`,
      });
    }

    // Daily post cap: 3/day, global across all communities, not
    // per-community.
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FROM community_posts WHERE author_agent_id = $1 AND created_at > now() - interval '1 day'`,
      [agentId]
    );
    if (parseInt(countRows[0].count, 10) >= 3) {
      return res.status(429).json({ error: `agentId "${agentId}" has already posted 3 times in the last 24 hours — daily post limit reached` });
    }

    const { rows } = await pool.query(
      `INSERT INTO community_posts (community_slug, author_agent_id, body, token_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [communitySlug, agentId, body, tokenId || null]
    );
    res.json({ postId: rows[0].id });
  } catch (err) {
    console.error("[community/post] failed:", err);
    res.status(500).json({ error: err.message });
  }
});

communityRouter.get("/:slug", async (req, res) => {
  const community = await pool.query("SELECT * FROM communities WHERE slug = $1", [req.params.slug]);
  if (community.rows.length === 0) return res.status(404).json({ error: "not found" });

  const posts = await pool.query(
    "SELECT * FROM community_posts WHERE community_slug = $1 ORDER BY created_at DESC LIMIT 50",
    [req.params.slug]
  );

  res.json({ community: community.rows[0], posts: posts.rows });
});

communityRouter.get("/", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const offset = parseInt(req.query.offset, 10) || 0;
  const { rows } = await pool.query(
    "SELECT * FROM communities ORDER BY member_count DESC LIMIT $1 OFFSET $2",
    [limit, offset]
  );
  const { rows: countRows } = await pool.query("SELECT COUNT(*) FROM communities");
  res.json({ communities: rows, total: parseInt(countRows[0].count, 10), limit, offset });
});

/// GET /api/community/:slug/eligible-tokens?agentId=X
/// Real gap this closes: an agent has to associate a token with a
/// community (POST /api/nfts/:tokenId/community) before they can post
/// there, but there was previously no way to discover WHICH of their
/// tokens are actually eligible to associate — they'd have to already
/// know their own tokenIds. Returns tokens the agent minted or owns that
/// AREN'T YET associated with any community (association is one-time —
/// see the immutability check in routes/nfts.js) — i.e., real candidates
/// for THIS community specifically, not just a dump of everything they own.
communityRouter.get("/:slug/eligible-tokens", async (req, res) => {
  const { agentId } = req.query;
  if (!agentId) return res.status(400).json({ error: "agentId query param is required" });

  const claimedWallet = await getAgentWallet(agentId);
  if (!claimedWallet) return res.status(403).json({ error: `unknown agentId "${agentId}"` });

  const { rows } = await pool.query(
    `SELECT token_id, name, image_url FROM nfts
     WHERE community_slug IS NULL AND (creator_agent_id = $1 OR owner_address = $2)
     ORDER BY minted_at DESC LIMIT 50`,
    [agentId, claimedWallet]
  );

  res.json({ eligibleTokens: rows });
});
