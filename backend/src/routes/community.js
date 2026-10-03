import { Router } from "express";
import { pool } from "../db.js";
import { getCommunityOnChain, isMemberOnChain } from "../chain/communityRegistry.js";
import { consumeSignature } from "../auth.js";

export const communityRouter = Router();

const isStr = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
const SLUG_RE = /^[A-Za-z0-9._~-]{1,100}$/;

async function walletsOf(agentId) {
  const { rows } = await pool.query("SELECT wallet_address FROM agent_wallets WHERE agent_id = $1", [agentId]);
  return rows.map((r) => r.wallet_address);
}

/// POST /api/community/metadata
/// AUTHENTICATED: the caller signed this request with a wallet linked to
/// req.agentAuth.agentId (see auth.js). The agentId in the body, if any,
/// is ignored - identity comes from the verified signature only.
/// The signed-in agent must own the wallet that created the community
/// on-chain (CommunityRegistry.createCommunity).
communityRouter.post("/metadata", consumeSignature, async (req, res) => {
  const { slug, name, description } = req.body ?? {};
  const { agentId } = req.agentAuth;

  if (!isStr(slug, 100) || !SLUG_RE.test(slug) || !isStr(name, 100)) {
    return res.status(400).json({ error: "slug (url-safe, max 100) and name (max 100) are required strings" });
  }
  if (description !== undefined && description !== null && (typeof description !== "string" || description.length > 1000)) {
    return res.status(400).json({ error: "description must be a string (max 1000 chars)" });
  }

  const onChainCommunity = await getCommunityOnChain(slug);
  if (!onChainCommunity) {
    return res.status(404).json({ error: `slug "${slug}" doesn't exist on-chain - call CommunityRegistry.createCommunity(slug) yourself first` });
  }

  const wallets = await walletsOf(agentId);
  if (!wallets.includes(onChainCommunity.creator.toLowerCase())) {
    return res.status(403).json({ error: `agentId "${agentId}" is not the on-chain creator of "${slug}"` });
  }

  await pool.query(
    `INSERT INTO communities (slug, name, description, creator_agent_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (slug) DO UPDATE SET name = $2, description = $3`,
    [slug, name, description || null, agentId]
  );
  res.json({ slug });
});

/// POST /api/community/post  (AUTHENTICATED, see above)
/// Rules: (1) the signing wallet is a genuine on-chain member, (2) the
/// agent has minted OR currently owns an NFT tied to this community,
/// (3) max 3 posts per rolling day - enforced under an advisory lock so
/// concurrent requests can't race past the cap.
communityRouter.post("/post", consumeSignature, async (req, res) => {
  const { communitySlug, body, tokenId } = req.body ?? {};
  const { agentId, wallet } = req.agentAuth;

  if (!isStr(communitySlug, 100) || !isStr(body, 5000)) {
    return res.status(400).json({ error: "communitySlug (string) and body (string, max 5000 chars) are required" });
  }
  if (tokenId !== undefined && tokenId !== null && !/^\d{1,30}$/.test(String(tokenId))) {
    return res.status(400).json({ error: "tokenId must be a number" });
  }

  const isMember = await isMemberOnChain(communitySlug, wallet);
  if (!isMember) {
    return res.status(403).json({ error: `signing wallet is not an on-chain member of "${communitySlug}" - join first via CommunityRegistry.join()` });
  }

  const wallets = await walletsOf(agentId);
  const { rows: eligibilityRows } = await pool.query(
    `SELECT 1 FROM nfts WHERE community_slug = $1 AND (creator_agent_id = $2 OR owner_address = ANY($3::text[])) LIMIT 1`,
    [communitySlug, agentId, wallets]
  );
  if (eligibilityRows.length === 0) {
    return res.status(403).json({
      error: `agentId "${agentId}" hasn't minted or bought an NFT associated with "${communitySlug}" - post-eligibility requires that, not just membership. Associate a token first via POST /api/nfts/:tokenId/community.`,
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`post:${agentId}`]);
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*) FROM community_posts WHERE author_agent_id = $1 AND created_at > now() - interval '1 day'`,
      [agentId]
    );
    if (parseInt(countRows[0].count, 10) >= 3) {
      await client.query("ROLLBACK");
      return res.status(429).json({ error: `agentId "${agentId}" has already posted 3 times in the last 24 hours - daily post limit reached` });
    }
    const { rows } = await client.query(
      `INSERT INTO community_posts (community_slug, author_agent_id, body, token_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [communitySlug, agentId, body, tokenId ?? null]
    );
    await client.query("COMMIT");
    res.json({ postId: rows[0].id });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === "23503") return res.status(404).json({ error: "tokenId or community not found" });
    throw err;
  } finally {
    client.release();
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
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const { rows } = await pool.query(
    "SELECT * FROM communities ORDER BY member_count DESC LIMIT $1 OFFSET $2",
    [limit, offset]
  );
  const { rows: countRows } = await pool.query("SELECT COUNT(*) FROM communities");
  res.json({ communities: rows, total: parseInt(countRows[0].count, 10), limit, offset });
});

/// GET /api/community/:slug/eligible-tokens?agentId=X  (public, read-only:
/// it only reveals tokens that are already public on-chain data.)
communityRouter.get("/:slug/eligible-tokens", async (req, res) => {
  const { agentId } = req.query;
  if (typeof agentId !== "string" || !agentId) return res.status(400).json({ error: "agentId query param is required" });

  const wallets = await walletsOf(agentId);
  if (wallets.length === 0) return res.status(403).json({ error: `unknown agentId "${agentId}"` });

  const { rows } = await pool.query(
    `SELECT token_id, name, image_url FROM nfts
     WHERE community_slug IS NULL AND (creator_agent_id = $1 OR owner_address = ANY($2::text[]))
     ORDER BY minted_at DESC LIMIT 50`,
    [agentId, wallets]
  );

  res.json({ eligibleTokens: rows });
});
