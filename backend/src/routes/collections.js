import { Router } from "express";
import { pool } from "../db.js";
import { config } from "../config.js";

export const collectionsRouter = Router();

/// GET /api/collections?limit=&offset=&mintEnded=
/// Paginated collection browsing — previously the only way to discover a
/// collection's existence/state was reading the contract directly via
/// get_contract_info's bare addresses. Real gap, closed here.
collectionsRouter.get("/", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = parseInt(req.query.offset, 10) || 0;
  const conditions = [];
  const params = [];

  if (req.query.mintEnded !== undefined) {
    params.push(req.query.mintEnded === "true");
    conditions.push(`mint_ended = $${params.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT * FROM collections ${whereClause} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM collections ${whereClause}`, params.slice(0, conditions.length));

  res.json({ collections: rows, total: parseInt(countRows[0].count, 10), limit, offset });
});

/// GET /api/collections/trending?window=24h|7d
/// MUST be declared before GET /:id — Express matches "trending" against
/// /:id otherwise, since /:id matches any single value.
collectionsRouter.get("/trending", async (req, res) => {
  const windowHours = req.query.window === "7d" ? 168 : 24;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

  const { rows } = await pool.query(
    `
    WITH current_window AS (
      SELECT n.collection_id, COUNT(*) AS sales, COALESCE(SUM(l.price_usdc), 0) AS volume
      FROM listings l JOIN nfts n ON n.token_id = l.token_id
      WHERE l.sold_at > now() - ($1 || ' hours')::interval
      GROUP BY n.collection_id
    ),
    prior_window AS (
      SELECT n.collection_id, COUNT(*) AS sales
      FROM listings l JOIN nfts n ON n.token_id = l.token_id
      WHERE l.sold_at <= now() - ($1 || ' hours')::interval
        AND l.sold_at > now() - (($1::int * 2) || ' hours')::interval
      GROUP BY n.collection_id
    )
    SELECT c.collection_id, c.verified, cw.sales, cw.volume,
           COALESCE(pw.sales, 0) AS prior_sales,
           cw.sales - COALESCE(pw.sales, 0) AS velocity
    FROM current_window cw
    JOIN collections c ON c.collection_id = cw.collection_id
    LEFT JOIN prior_window pw ON pw.collection_id = cw.collection_id
    ORDER BY cw.volume DESC, velocity DESC
    LIMIT $2
    `,
    [windowHours, limit]
  );

  res.json({ windowHours, trending: rows });
});

collectionsRouter.get("/:id", async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "id must be a number" });
  const { rows } = await pool.query("SELECT * FROM collections WHERE collection_id = $1", [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

/// GET /api/collections/:id/stats
/// Real, derived-from-actual-data marketplace stats — no fabricated
/// numbers. floorPrice = cheapest active listing among this collection's
/// tokens. volumeAllTime/volume24h = sum of actual settled sale prices
/// (listings.sold_at IS NOT NULL), not listing prices. ownersCount =
/// distinct current owners, a reasonable proxy for "how spread out is
/// this collection" even without a dedicated holders table.
collectionsRouter.get("/:id/stats", async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "id must be a number" });
  const collectionId = req.params.id;

  const { rows: collectionRows } = await pool.query("SELECT * FROM collections WHERE collection_id = $1", [collectionId]);
  if (collectionRows.length === 0) return res.status(404).json({ error: "not found" });

  const { rows: floorRows } = await pool.query(
    `SELECT MIN(l.price_usdc) AS floor_price
     FROM listings l JOIN nfts n ON n.token_id = l.token_id
     WHERE n.collection_id = $1 AND l.active = true`,
    [collectionId]
  );

  const { rows: volumeRows } = await pool.query(
    `SELECT
       COALESCE(SUM(l.price_usdc), 0) AS volume_all_time,
       COALESCE(SUM(l.price_usdc) FILTER (WHERE l.sold_at > now() - interval '1 day'), 0) AS volume_24h,
       COUNT(*) AS sales_count
     FROM listings l JOIN nfts n ON n.token_id = l.token_id
     WHERE n.collection_id = $1 AND l.sold_at IS NOT NULL`,
    [collectionId]
  );

  const { rows: ownerRows } = await pool.query(
    `SELECT COUNT(DISTINCT owner_address) AS owners_count FROM nfts WHERE collection_id = $1`,
    [collectionId]
  );

  const { rows: listedRows } = await pool.query(
    `SELECT COUNT(*) AS listed_count
     FROM listings l JOIN nfts n ON n.token_id = l.token_id
     WHERE n.collection_id = $1 AND l.active = true`,
    [collectionId]
  );

  const { rows: topOfferRows } = await pool.query(
    `SELECT MAX(o.amount_usdc) AS top_offer
     FROM offers o JOIN nfts n ON n.token_id = o.token_id
     WHERE n.collection_id = $1 AND o.active = true AND o.expires_at > now()`,
    [collectionId]
  );

  res.json({
    collectionId,
    maxSupply: collectionRows[0].max_supply,
    mintedCount: collectionRows[0].minted_count,
    mintEnded: collectionRows[0].mint_ended,
    floorPriceUsdc: floorRows[0].floor_price,
    topOfferUsdc: topOfferRows[0].top_offer,
    volumeAllTimeUsdc: volumeRows[0].volume_all_time,
    volume24hUsdc: volumeRows[0].volume_24h,
    salesCount: parseInt(volumeRows[0].sales_count, 10),
    ownersCount: parseInt(ownerRows[0].owners_count, 10),
    listedCount: parseInt(listedRows[0].listed_count, 10),
  });
});

collectionsRouter.get("/:id/traits", async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "id must be a number" });
  const { rows } = await pool.query(
    `SELECT token_id, attributes FROM nfts WHERE collection_id = $1 AND attributes IS NOT NULL`,
    [req.params.id]
  );

  if (rows.length === 0) return res.json({ traitFrequency: {}, tokenRarity: [] });

  const traitCounts = {};
  for (const row of rows) {
    for (const attr of row.attributes || []) {
      traitCounts[attr.trait_type] ??= {};
      traitCounts[attr.trait_type][attr.value] = (traitCounts[attr.trait_type][attr.value] || 0) + 1;
    }
  }

  const totalTokens = rows.length;
  const tokenRarity = rows.map((row) => {
    let score = 0;
    for (const attr of row.attributes || []) {
      const frequency = traitCounts[attr.trait_type][attr.value] / totalTokens;
      score += 1 / frequency;
    }
    return { tokenId: row.token_id, rarityScore: Math.round(score * 100) / 100 };
  });

  tokenRarity.sort((a, b) => b.rarityScore - a.rarityScore);

  res.json({ traitFrequency: traitCounts, totalTokensWithTraits: totalTokens, tokenRarity });
});

collectionsRouter.get("/:id/price-history", async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "id must be a number" });
  const bucketUnit = req.query.bucket === "hour" ? "hour" : "day";

  const { rows } = await pool.query(
    `SELECT date_trunc($2, l.sold_at) AS bucket, AVG(l.price_usdc) AS avg_price, COUNT(*) AS sales_count
     FROM listings l JOIN nfts n ON n.token_id = l.token_id
     WHERE n.collection_id = $1 AND l.sold_at IS NOT NULL
     GROUP BY bucket
     ORDER BY bucket ASC`,
    [req.params.id, bucketUnit]
  );

  res.json({ bucket: bucketUnit, history: rows });
});

/// POST /api/collections/:id/verify
/// Marks a collection as verified — shown as a trust signal on the
/// frontend. Owner-operator-only, gated by a shared secret header, not a
/// real multi-admin auth system. Requires ADMIN_SECRET to be set in
/// .env — if it's blank, this route refuses ALL requests (fails closed,
/// not open).
collectionsRouter.post("/:id/verify", async (req, res) => {
  if (!config.adminSecret || req.header("X-Admin-Secret") !== config.adminSecret) {
    return res.status(403).json({ error: "invalid or missing admin secret" });
  }
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "id must be a number" });

  const verified = req.body.verified !== false; // defaults to true
  const { rows } = await pool.query(
    "UPDATE collections SET verified = $1 WHERE collection_id = $2 RETURNING collection_id, verified",
    [verified, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

/// GET /api/collections/:id/offers
/// Every active, non-expired offer across ALL tokens in this collection,
/// highest first — the collection-wide view OpenSea's "Offers" tab shows,
/// distinct from GET /api/nfts/:tokenId/offers which is scoped to one
/// token. Real escrowed USDC amounts from Offers.sol via the indexer.
collectionsRouter.get("/:id/offers", async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "id must be a number" });

  const { rows } = await pool.query(
    `SELECT o.*, n.name, n.image_url
     FROM offers o JOIN nfts n ON n.token_id = o.token_id
     WHERE n.collection_id = $1 AND o.active = true AND o.expires_at > now()
     ORDER BY o.amount_usdc DESC`,
    [req.params.id]
  );

  res.json({ offers: rows });
});

/// GET /api/collections/:id/holders
/// Distinct owners of tokens in this collection, ranked by how many they
/// hold, with each holder's share of the collection as a percentage —
/// computed live from nfts.owner_address, never cached/stale.
collectionsRouter.get("/:id/holders", async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "id must be a number" });

  const { rows } = await pool.query(
    `SELECT owner_address, COUNT(*) AS token_count
     FROM nfts
     WHERE collection_id = $1
     GROUP BY owner_address
     ORDER BY token_count DESC`,
    [req.params.id]
  );

  const totalTokens = rows.reduce((sum, r) => sum + parseInt(r.token_count, 10), 0);
  const holders = rows.map((r) => ({
    ownerAddress: r.owner_address,
    tokenCount: parseInt(r.token_count, 10),
    percentage: totalTokens > 0 ? Math.round((parseInt(r.token_count, 10) / totalTokens) * 10000) / 100 : 0,
  }));

  res.json({ holders, uniqueHolders: holders.length, totalTokens });
});

/// GET /api/collections/:id/items
/// EVERY token minted in this collection — listed or not — the real
/// "Items" tab data, distinct from marketplace/listings which only shows
/// what's currently for sale. Each item includes its active listing
/// price if one exists (LEFT JOIN — null if not listed).
collectionsRouter.get("/:id/items", async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "id must be a number" });
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const offset = parseInt(req.query.offset, 10) || 0;

  const { rows } = await pool.query(
    `SELECT n.token_id, n.name, n.image_url, n.owner_address, n.creator_agent_id, n.minted_at,
            l.price_usdc, l.listing_id
     FROM nfts n
     LEFT JOIN listings l ON l.token_id = n.token_id AND l.active = true
     WHERE n.collection_id = $1
     ORDER BY n.token_id ASC
     LIMIT $2 OFFSET $3`,
    [req.params.id, limit, offset]
  );

  const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM nfts WHERE collection_id = $1`, [req.params.id]);

  res.json({ items: rows, total: parseInt(countRows[0].count, 10), limit, offset });
});