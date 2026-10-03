import { Router } from "express";
import { pool } from "../db.js";
import { consumeSignature } from "../auth.js";

export const watchlistRouter = Router();

const isId = (v) => v !== undefined && v !== null && /^\d{1,30}$/.test(String(v));

/// GET is public and read-only (a watchlist only references public
/// on-chain tokens/collections).
watchlistRouter.get("/", async (req, res) => {
  const { agentId } = req.query;
  if (typeof agentId !== "string" || !agentId) return res.status(400).json({ error: "agentId query param is required" });

  const { rows } = await pool.query(
    `SELECT w.id, w.token_id, w.collection_id, w.created_at,
            n.name AS token_name, n.image_url AS token_image_url,
            c.max_supply, c.minted_count, (c.mint_ended OR c.created_at + interval '30 days' <= now()) AS mint_ended
     FROM watchlist_items w
     LEFT JOIN nfts n ON n.token_id = w.token_id
     LEFT JOIN collections c ON c.collection_id = w.collection_id
     WHERE w.agent_id = $1
     ORDER BY w.created_at DESC
     LIMIT 500`,
    [agentId]
  );
  res.json({ items: rows });
});

/// POST/DELETE are AUTHENTICATED: identity is the signed-in agent
/// (req.agentAuth), never a caller-supplied agentId - otherwise anyone
/// could fill or wipe another agent's watchlist.
watchlistRouter.post("/", consumeSignature, async (req, res) => {
  const { tokenId, collectionId } = req.body ?? {};
  const { agentId } = req.agentAuth;
  if (isId(tokenId) === isId(collectionId)) {
    return res.status(400).json({ error: "provide exactly one numeric tokenId or collectionId, not both or neither" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO watchlist_items (agent_id, token_id, collection_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING id`,
      [agentId, isId(tokenId) ? String(tokenId) : null, isId(collectionId) ? String(collectionId) : null]
    );
    if (rows.length === 0) return res.status(409).json({ error: "already on watchlist" });
    res.json({ id: rows[0].id });
  } catch (err) {
    if (err.code === "23503") return res.status(404).json({ error: "tokenId or collectionId not found" });
    throw err;
  }
});

watchlistRouter.delete("/:id", consumeSignature, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "id must be a number" });
  const { rows } = await pool.query(
    `DELETE FROM watchlist_items WHERE id = $1 AND agent_id = $2 RETURNING id`,
    [req.params.id, req.agentAuth.agentId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "not found, or you don't own it" });
  res.json({ deleted: true });
});
