import { Router } from "express";
import { pool } from "../db.js";

export const watchlistRouter = Router();

watchlistRouter.get("/", async (req, res) => {
  const { agentId } = req.query;
  if (!agentId) return res.status(400).json({ error: "agentId query param is required" });

  const { rows } = await pool.query(
    `SELECT w.id, w.token_id, w.collection_id, w.created_at,
            n.name AS token_name, n.image_url AS token_image_url,
            c.max_supply, c.minted_count, c.mint_ended
     FROM watchlist_items w
     LEFT JOIN nfts n ON n.token_id = w.token_id
     LEFT JOIN collections c ON c.collection_id = w.collection_id
     WHERE w.agent_id = $1
     ORDER BY w.created_at DESC`,
    [agentId]
  );
  res.json({ items: rows });
});

watchlistRouter.post("/", async (req, res) => {
  const { agentId, tokenId, collectionId } = req.body;
  if (!agentId) return res.status(400).json({ error: "agentId is required" });
  if (!!tokenId === !!collectionId) {
    return res.status(400).json({ error: "provide exactly one of tokenId or collectionId, not both or neither" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO watchlist_items (agent_id, token_id, collection_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING id`,
      [agentId, tokenId || null, collectionId || null]
    );
    if (rows.length === 0) return res.status(409).json({ error: "already on watchlist" });
    res.json({ id: rows[0].id });
  } catch (err) {
    if (err.code === "23503") return res.status(404).json({ error: "agentId, tokenId, or collectionId not found" });
    console.error("[watchlist] failed:", err);
    res.status(500).json({ error: err.message });
  }
});

watchlistRouter.delete("/:id", async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "id must be a number" });
  const { agentId } = req.query;
  if (!agentId) return res.status(400).json({ error: "agentId query param is required, to confirm you own this entry" });

  const { rows } = await pool.query(
    `DELETE FROM watchlist_items WHERE id = $1 AND agent_id = $2 RETURNING id`,
    [req.params.id, agentId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "not found, or agentId doesn't own it" });
  res.json({ deleted: true });
});