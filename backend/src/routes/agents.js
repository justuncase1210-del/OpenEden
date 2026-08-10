import { Router } from "express";
import { pool } from "../db.js";

export const agentsRouter = Router();

/// GET /api/agents?limit=&offset=
/// Every registered agent, most recently registered first — powers the
/// directory page, since there was previously no way to discover an
/// agentId without already knowing it.
agentsRouter.get("/", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const offset = parseInt(req.query.offset, 10) || 0;

  const { rows } = await pool.query(
    `SELECT agent_id, name, wallet_address, created_at FROM agents ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM agents`);

  res.json({ agents: rows, total: parseInt(countRows[0].count, 10), limit, offset });
});

/// GET /api/agents/:agentId/reputation
/// A transparent starting-point formula, not a validated system.
agentsRouter.get("/:agentId/reputation", async (req, res) => {
  const { agentId } = req.params;

  const { rows: agentRows } = await pool.query("SELECT wallet_address, created_at FROM agents WHERE agent_id = $1", [agentId]);
  if (agentRows.length === 0) return res.status(404).json({ error: "unknown agentId" });
  const wallet = agentRows[0].wallet_address;

  const [sales, purchasesViaListing, purchasesViaOffer, collectionsCreated, communityPosts] = await Promise.all([
    pool.query(`SELECT COUNT(*) FROM listings WHERE seller_address = $1 AND sold_at IS NOT NULL`, [wallet]),
    pool.query(`SELECT COUNT(*) FROM listings WHERE buyer_address = $1`, [wallet]),
    pool.query(`SELECT COUNT(*) FROM offers WHERE offerer_address = $1 AND accepted_at IS NOT NULL`, [wallet]),
    pool.query(`SELECT COUNT(*) FROM collections WHERE creator_wallet = $1`, [wallet]),
    pool.query(`SELECT COUNT(*) FROM community_posts WHERE author_agent_id = $1`, [agentId]),
  ]);

  const components = {
    completedSalesAsSeller: parseInt(sales.rows[0].count, 10),
    completedPurchases: parseInt(purchasesViaListing.rows[0].count, 10) + parseInt(purchasesViaOffer.rows[0].count, 10),
    collectionsCreated: parseInt(collectionsCreated.rows[0].count, 10),
    communityPosts: parseInt(communityPosts.rows[0].count, 10),
  };

  const score =
    components.completedSalesAsSeller * 2 +
    components.completedPurchases * 2 +
    components.collectionsCreated * 3 +
    components.communityPosts * 1;

  res.json({
    agentId,
    score,
    components,
    memberSince: agentRows[0].created_at,
    note: "A starting-point formula, not a validated reputation system.",
  });
});