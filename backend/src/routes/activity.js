import { Router } from "express";
import { pool } from "../db.js";

export const activityRouter = Router();

activityRouter.get("/", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const offset = parseInt(req.query.offset, 10) || 0;
  const { tokenId, collectionId } = req.query;

  const params = [tokenId || null, collectionId || null, limit, offset];

  const { rows } = await pool.query(
    `
    SELECT 'minted' AS event_type, n.token_id, n.collection_id, n.owner_address AS actor_address,
           NULL::numeric AS amount_usdc, n.minted_at AS occurred_at
    FROM nfts n
    WHERE ($1::bigint IS NULL OR n.token_id = $1) AND ($2::bigint IS NULL OR n.collection_id = $2)

    UNION ALL

    SELECT 'listed' AS event_type, l.token_id, n.collection_id, l.seller_address AS actor_address,
           l.price_usdc AS amount_usdc, l.created_at AS occurred_at
    FROM listings l JOIN nfts n ON n.token_id = l.token_id
    WHERE ($1::bigint IS NULL OR l.token_id = $1) AND ($2::bigint IS NULL OR n.collection_id = $2)

    UNION ALL

    SELECT 'sold' AS event_type, l.token_id, n.collection_id, l.buyer_address AS actor_address,
           l.price_usdc AS amount_usdc, l.sold_at AS occurred_at
    FROM listings l JOIN nfts n ON n.token_id = l.token_id
    WHERE l.sold_at IS NOT NULL
      AND ($1::bigint IS NULL OR l.token_id = $1) AND ($2::bigint IS NULL OR n.collection_id = $2)

    UNION ALL

    SELECT 'cancelled' AS event_type, l.token_id, n.collection_id, l.seller_address AS actor_address,
           l.price_usdc AS amount_usdc, l.cancelled_at AS occurred_at
    FROM listings l JOIN nfts n ON n.token_id = l.token_id
    WHERE l.cancelled_at IS NOT NULL
      AND ($1::bigint IS NULL OR l.token_id = $1) AND ($2::bigint IS NULL OR n.collection_id = $2)

    UNION ALL

    SELECT 'offer_made' AS event_type, o.token_id, n.collection_id, o.offerer_address AS actor_address,
           o.amount_usdc, o.created_at AS occurred_at
    FROM offers o JOIN nfts n ON n.token_id = o.token_id
    WHERE ($1::bigint IS NULL OR o.token_id = $1) AND ($2::bigint IS NULL OR n.collection_id = $2)

    UNION ALL

    SELECT 'offer_accepted' AS event_type, o.token_id, n.collection_id, n.owner_address AS actor_address,
           o.amount_usdc, o.accepted_at AS occurred_at
    FROM offers o JOIN nfts n ON n.token_id = o.token_id
    WHERE o.accepted_at IS NOT NULL
      AND ($1::bigint IS NULL OR o.token_id = $1) AND ($2::bigint IS NULL OR n.collection_id = $2)

    ORDER BY occurred_at DESC NULLS LAST
    LIMIT $3 OFFSET $4
    `,
    params
  );

  res.json({ activity: rows, limit, offset });
});