import { formatUnits } from "viem";
import { pool } from "../db.js";
import { publicClient } from "../chain/viemClient.js";
import { config } from "../config.js";
import { COMMUNITY_REGISTRY_EVENTS_ABI, OFFERS_EVENTS_ABI } from "./abis.js";
import { fetchTokenMetadata } from "./metadata.js";

/// Every handler is idempotent (safe to run any number of times for the
/// same event, in order) - the indexer replays from a fixed floor on first
/// run and re-processes whole chunks after any failure, so correctness of
/// replays is what makes "never skip an event" achievable.
///
/// Handlers receive (args, ctx). ctx.timestamp is the BLOCK's timestamp, so
/// created_at / sold_at / etc. reflect when things happened on-chain, not
/// when this process happened to index them (which broke trending, price
/// history and the wash-trading window after any re-index).
///
/// All addresses are stored lowercase (see db.js).

const lc = (a) => a.toLowerCase();
const usdc = (raw) => formatUnits(raw, 6); // exact decimal string, no float rounding

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function handleCollectionCreated({ collectionId, creator, creatorAgentId, maxSupply }, ctx) {
  await pool.query(
    `INSERT INTO collections (collection_id, contract_address, creator_agent_id, creator_wallet, max_supply, minted_count, mint_ended, created_at)
     VALUES ($1, $2, $3, $4, $5, 0, false, $6)
     ON CONFLICT (collection_id) DO NOTHING`,
    [collectionId, config.chain.nftContractAddress, creatorAgentId, lc(creator), maxSupply, ctx.timestamp]
  );
}

export async function handleMintEnded({ collectionId }) {
  await pool.query(`UPDATE collections SET mint_ended = true WHERE collection_id = $1`, [collectionId]);
}

export async function handleMintPriceUpdated({ collectionId, priceUsdc }) {
  await pool.query(`UPDATE collections SET mint_price_usdc = $1 WHERE collection_id = $2`, [usdc(priceUsdc), collectionId]);
}

export async function handleMinted({ tokenId, collectionId, to, agentId, tokenURI }, ctx) {
  const { rows: existing } = await pool.query("SELECT 1 FROM nfts WHERE token_id = $1", [tokenId]);
  if (existing.length > 0) return; // replay - already indexed, and never revert a newer owner

  const meta = await fetchTokenMetadata(tokenURI);

  await withTx(async (client) => {
    const inserted = await client.query(
      `INSERT INTO nfts (token_id, contract_address, collection_id, owner_address, creator_agent_id, token_uri, name, description, image_url, attributes, minted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
       ON CONFLICT (token_id) DO NOTHING`,
      [
        tokenId, config.chain.nftContractAddress, collectionId, lc(to), agentId, tokenURI,
        meta.name, meta.description, meta.imageUrl, meta.attributes ? JSON.stringify(meta.attributes) : null, ctx.timestamp,
      ]
    );
    if (inserted.rowCount === 0) return;
    // Mirrors AgentNFT.isCollectionMintEnded()'s sell-out condition.
    await client.query(
      `UPDATE collections
       SET minted_count = minted_count + 1,
           mint_ended = (minted_count + 1 >= max_supply) OR mint_ended
       WHERE collection_id = $1`,
      [collectionId]
    );
  });
}

export async function handleListed({ listingId, seller, tokenId, price }, ctx) {
  await pool.query(
    `INSERT INTO listings (listing_id, token_id, seller_address, price_usdc, active, created_at)
     VALUES ($1, $2, $3, $4, true, $5)
     ON CONFLICT (listing_id) DO NOTHING`,
    [listingId, tokenId, lc(seller), usdc(price), ctx.timestamp]
  );
}

export async function handleSold({ listingId, buyer }, ctx) {
  await withTx(async (client) => {
    // buyer_address was never written before, which silently emptied
    // detect_wash_trading, reputation purchases and the activity feed.
    const { rows } = await client.query(
      `UPDATE listings SET active = false, buyer_address = $2, sold_at = $3 WHERE listing_id = $1 RETURNING token_id`,
      [listingId, lc(buyer), ctx.timestamp]
    );
    if (rows.length > 0) {
      await client.query(`UPDATE nfts SET owner_address = $1 WHERE token_id = $2`, [lc(buyer), rows[0].token_id]);
    }
  });
}

export async function handleCancelled({ listingId }, ctx) {
  await pool.query(`UPDATE listings SET active = false, cancelled_at = $2 WHERE listing_id = $1 AND sold_at IS NULL`, [listingId, ctx.timestamp]);
}

// slugHash -> slug, filled from CommunityCreated and, on a miss, the contract.
const slugCache = new Map();

export async function handleCommunityCreated({ slugHash, slug, creatorAgentId }, ctx) {
  slugCache.set(slugHash, slug);
  // member_count starts at 0: the creator's auto-join emits its own
  // MemberJoined, which is what populates community_members.
  await pool.query(
    `INSERT INTO communities (slug, name, creator_agent_id, member_count, created_at)
     VALUES ($1, $1, $2, 0, $3)
     ON CONFLICT (slug) DO UPDATE SET creator_agent_id = EXCLUDED.creator_agent_id`,
    [slug, creatorAgentId, ctx.timestamp]
  );
}

async function resolveSlugFromHash(slugHash) {
  if (slugCache.has(slugHash)) return slugCache.get(slugHash);
  const [slug] = await publicClient.readContract({
    address: config.chain.communityRegistryAddress,
    abi: COMMUNITY_REGISTRY_EVENTS_ABI,
    functionName: "communities",
    args: [slugHash],
  });
  if (slugCache.size > 5000) slugCache.clear();
  slugCache.set(slugHash, slug);
  return slug;
}

async function recountMembers(client, slug) {
  await client.query(
    `UPDATE communities SET member_count = (SELECT COUNT(*) FROM community_members WHERE slug = $1) WHERE slug = $1`,
    [slug]
  );
}

export async function handleMemberJoined({ slugHash, member }) {
  const slug = await resolveSlugFromHash(slugHash);
  await withTx(async (client) => {
    await client.query(`INSERT INTO community_members (slug, wallet_address) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [slug, lc(member)]);
    await recountMembers(client, slug);
  });
}

export async function handleMemberLeft({ slugHash, member }) {
  const slug = await resolveSlugFromHash(slugHash);
  await withTx(async (client) => {
    await client.query(`DELETE FROM community_members WHERE slug = $1 AND wallet_address = $2`, [slug, lc(member)]);
    await recountMembers(client, slug);
  });
}

export async function handleOfferMade({ offerId, offerer, tokenId, amount, expiresAt }, ctx) {
  await pool.query(
    `INSERT INTO offers (offer_id, token_id, offerer_address, amount_usdc, expires_at, active, created_at)
     VALUES ($1, $2, $3, $4, to_timestamp($5), true, $6)
     ON CONFLICT (offer_id) DO NOTHING`,
    [offerId, tokenId, lc(offerer), usdc(amount), Number(expiresAt), ctx.timestamp]
  );
}

export async function handleOfferCancelled({ offerId }, ctx) {
  await pool.query(`UPDATE offers SET active = false, cancelled_at = $2 WHERE offer_id = $1 AND accepted_at IS NULL`, [offerId, ctx.timestamp]);
}

/// OfferAccepted(offerId, accepter, amount): despite its name, the second
/// arg is Offers.sol's `offer.offerer` - the BUYER, i.e. the token's new
/// owner. tokenId is not in the event, so it is read from the contract's
/// public `offers` mapping.
export async function handleOfferAccepted({ offerId, accepter: newOwner }, ctx) {
  const [, , tokenId] = await publicClient.readContract({
    address: config.chain.offersContractAddress,
    abi: OFFERS_EVENTS_ABI,
    functionName: "offers",
    args: [offerId],
  });

  await withTx(async (client) => {
    await client.query(`UPDATE offers SET active = false, accepted_at = $2 WHERE offer_id = $1`, [offerId, ctx.timestamp]);
    await client.query(`UPDATE nfts SET owner_address = $1 WHERE token_id = $2`, [lc(newOwner), tokenId]);
  });
}

export const HANDLERS = {
  CollectionCreated: handleCollectionCreated,
  MintEnded: handleMintEnded,
  MintPriceUpdated: handleMintPriceUpdated,
  Minted: handleMinted,
  Listed: handleListed,
  Sold: handleSold,
  Cancelled: handleCancelled,
  CommunityCreated: handleCommunityCreated,
  MemberJoined: handleMemberJoined,
  MemberLeft: handleMemberLeft,
  OfferMade: handleOfferMade,
  OfferCancelled: handleOfferCancelled,
  OfferAccepted: handleOfferAccepted,
};
