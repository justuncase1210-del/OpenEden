import { Router } from "express";
import { pool } from "../db.js";

export const marketplaceRouter = Router();

/// list/buy are direct on-chain calls agents make THEMSELVES against
/// Marketplace.sol — Marketplace.list(tokenId, price) and
/// Marketplace.buy(listingId), signed with the agent's own wallet. There
/// is deliberately no backend route for either; Marketplace.sol checks
/// msg.sender against AgentRegistry directly (onlyAgent modifier).
///
/// GET /api/marketplace/listings?limit=&offset=&communitySlug=&collectionId=&maxPriceUsdc=
/// Paginated (limit/offset + total count, matching the pattern used by
/// /api/community and /api/collections — this route previously only had
/// a bare `limit`, no offset or total, inconsistent with the rest of the
/// API). Populated by the indexer (indexer/handlers.js) reacting to real
/// Listed/Sold/Cancelled events — not a stub, genuinely reflects on-chain
/// state once the indexer has caught up.
marketplaceRouter.get("/listings", async (req, res) => {
  const { communitySlug, collectionId, maxPriceUsdc } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  if (collectionId !== undefined && !/^\d{1,30}$/.test(String(collectionId))) return res.status(400).json({ error: "collectionId must be a number" });
  if (maxPriceUsdc !== undefined && !/^\d{1,20}(\.\d{1,6})?$/.test(String(maxPriceUsdc))) return res.status(400).json({ error: "maxPriceUsdc must be a decimal number" });
  if (communitySlug !== undefined && (typeof communitySlug !== "string" || communitySlug.length > 100)) return res.status(400).json({ error: "communitySlug must be a string" });

  const conditions = ["l.active = true"];
  const params = [];

  if (communitySlug) {
    params.push(communitySlug);
    conditions.push(`n.community_slug = $${params.length}`);
  }
  if (collectionId) {
    params.push(collectionId);
    conditions.push(`n.collection_id = $${params.length}`);
  }
  if (maxPriceUsdc) {
    params.push(maxPriceUsdc);
    conditions.push(`l.price_usdc <= $${params.length}`);
  }

  const whereClause = conditions.join(" AND ");
  const listParams = [...params, limit, offset];

  const { rows } = await pool.query(
    `SELECT l.*, n.name, n.image_url, n.collection_id
     FROM listings l JOIN nfts n ON n.token_id = l.token_id
     WHERE ${whereClause}
     ORDER BY l.created_at DESC
     LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams
  );

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) FROM listings l JOIN nfts n ON n.token_id = l.token_id WHERE ${whereClause}`,
    params
  );

  res.json({ listings: rows, total: parseInt(countRows[0].count, 10), limit, offset });
});
