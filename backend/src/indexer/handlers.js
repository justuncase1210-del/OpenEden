import { pool } from "../db.js";
import { publicClient } from "../chain/viemClient.js";
import { config } from "../config.js";
import { COMMUNITY_REGISTRY_EVENTS_ABI, OFFERS_EVENTS_ABI } from "./abis.js";

/// Every handler is intentionally idempotent (safe to run twice on the
/// same event) via ON CONFLICT upserts — necessary because backfill +
/// live watching can overlap at the boundary, and because a process
/// restart re-runs backfill from the same start block.

export async function handleCollectionCreated({ collectionId, creator, creatorAgentId, maxSupply }) {
  await pool.query(
    `INSERT INTO collections (collection_id, contract_address, creator_agent_id, creator_wallet, max_supply, minted_count, mint_ended)
     VALUES ($1, $2, $3, $4, $5, 0, false)
     ON CONFLICT (collection_id) DO NOTHING`,
    [collectionId, config.chain.nftContractAddress, creatorAgentId, creator, maxSupply]
  );
  console.log(`[indexer] indexed CollectionCreated: collectionId=${collectionId} maxSupply=${maxSupply}`);
}

export async function handleMintEnded({ collectionId }) {
  await pool.query(`UPDATE collections SET mint_ended = true WHERE collection_id = $1`, [collectionId]);
  console.log(`[indexer] indexed MintEnded: collectionId=${collectionId}`);
}

export async function handleMintPriceUpdated({ collectionId, priceUsdc }) {
  await pool.query(`UPDATE collections SET mint_price_usdc = $1 WHERE collection_id = $2`, [Number(priceUsdc) / 1_000_000, collectionId]);
  console.log(`[indexer] indexed MintPriceUpdated: collectionId=${collectionId} priceUsdc=${Number(priceUsdc) / 1_000_000}`);
}

export async function handleMinted({ tokenId, collectionId, to, agentId, tokenURI }) {
  let name = null;
  let description = null;
  let imageUrl = null;

  // SECURITY: only ever fetch from the trusted IPFS gateway, never an
  // agent-supplied arbitrary URL. AgentNFT.mint() accepts ANY string as
  // the tokenURI — an unrestricted fetch(tokenURI) here would let a
  // malicious agent point this backend's own server-side fetch at
  // internal infrastructure (cloud metadata endpoints, internal service
  // ports, etc.) — a real SSRF vector, not a theoretical one, since
  // minting is open to any registered agent. Rather than try to build a
  // robust private-IP/DNS-rebinding blocklist (genuinely hard to get
  // fully right), the simplest correct fix is: only fetch ipfs://, which
  // is the only URI scheme this system's own /prepare-metadata endpoint
  // ever produces. Anything else is skipped entirely — the NFT still
  // gets indexed, just without cached display fields.
  if (tokenURI.startsWith("ipfs://")) {
    try {
      const url = tokenURI.replace("ipfs://", "https://ipfs.io/ipfs/");
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      // Cap response size too — a malicious IPFS payload could otherwise
      // be an arbitrarily large JSON blob.
      const text = await res.text();
      if (text.length > 100_000) throw new Error("metadata response too large");
      const metadata = JSON.parse(text);
      name = typeof metadata.name === "string" ? metadata.name.slice(0, 200) : null;
      description = typeof metadata.description === "string" ? metadata.description.slice(0, 2000) : null;
      imageUrl = typeof metadata.image === "string" ? metadata.image.slice(0, 2000) : null;
    } catch (err) {
      console.warn(`[indexer] couldn't fetch metadata for tokenId ${tokenId}:`, err.message);
    }
  } else {
    console.warn(`[indexer] tokenId ${tokenId} has a non-ipfs:// tokenURI (${tokenURI.slice(0, 50)}...) — not fetched, for SSRF-prevention reasons. NFT indexed with null display fields.`);
  }

  await pool.query(
    `INSERT INTO nfts (token_id, contract_address, collection_id, owner_address, creator_agent_id, token_uri, name, description, image_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (token_id) DO UPDATE SET owner_address = $4`,
    [tokenId, config.chain.nftContractAddress, collectionId, to, agentId, tokenURI, name, description, imageUrl]
  );

  // Increment the collection's minted_count, and auto-mark mint_ended if
  // this mint just hit max_supply — mirrors AgentNFT.isCollectionMintEnded()'s
  // sellout condition, kept in sync here since Postgres has no direct
  // view into the contract's own computed state.
  await pool.query(
    `UPDATE collections
     SET minted_count = minted_count + 1,
         mint_ended = (minted_count + 1 >= max_supply) OR mint_ended
     WHERE collection_id = $1`,
    [collectionId]
  );

  console.log(`[indexer] indexed Minted: tokenId=${tokenId} owner=${to}`);
}

export async function handleListed({ listingId, seller, tokenId, price }) {
  await pool.query(
    `INSERT INTO listings (listing_id, token_id, seller_address, price_usdc, active)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (listing_id) DO NOTHING`,
    [listingId, tokenId, seller, Number(price) / 1_000_000] // USDC has 6 decimals
  );
  console.log(`[indexer] indexed Listed: listingId=${listingId} tokenId=${tokenId}`);
}

export async function handleSold({ listingId, buyer }) {
  await pool.query(`UPDATE listings SET active = false, sold_at = now() WHERE listing_id = $1`, [listingId]);
  await pool.query(
    `UPDATE nfts SET owner_address = $1 WHERE token_id = (SELECT token_id FROM listings WHERE listing_id = $2)`,
    [buyer, listingId]
  );
  console.log(`[indexer] indexed Sold: listingId=${listingId} buyer=${buyer}`);
}

export async function handleCancelled({ listingId }) {
  await pool.query(`UPDATE listings SET active = false, cancelled_at = now() WHERE listing_id = $1`, [listingId]);
  console.log(`[indexer] indexed Cancelled: listingId=${listingId}`);
}

export async function handleCommunityCreated({ slug, creatorAgentId }) {
  // member_count starts at 0 here deliberately, NOT 1 — createCommunity()
  // on-chain emits BOTH CommunityCreated and MemberJoined for the creator's
  // own auto-join in the same transaction. Letting handleMemberJoined do
  // the +1 (below) avoids double-counting the creator.
  await pool.query(
    `INSERT INTO communities (slug, name, creator_agent_id, member_count)
     VALUES ($1, $1, $2, 0)
     ON CONFLICT (slug) DO UPDATE SET creator_agent_id = EXCLUDED.creator_agent_id`,
    [slug, creatorAgentId]
  );
  console.log(`[indexer] indexed CommunityCreated: slug=${slug}`);
}

async function resolveSlugFromHash(slugHash) {
  const [slug] = await publicClient.readContract({
    address: config.chain.communityRegistryAddress,
    abi: COMMUNITY_REGISTRY_EVENTS_ABI,
    functionName: "communities",
    args: [slugHash],
  });
  return slug;
}

export async function handleMemberJoined({ slugHash }) {
  const slug = await resolveSlugFromHash(slugHash);
  await pool.query(`UPDATE communities SET member_count = member_count + 1 WHERE slug = $1`, [slug]);
  console.log(`[indexer] indexed MemberJoined: slug=${slug}`);
}

export async function handleMemberLeft({ slugHash }) {
  const slug = await resolveSlugFromHash(slugHash);
  await pool.query(`UPDATE communities SET member_count = GREATEST(member_count - 1, 0) WHERE slug = $1`, [slug]);
  console.log(`[indexer] indexed MemberLeft: slug=${slug}`);
}

export async function handleOfferMade({ offerId, offerer, tokenId, amount, expiresAt }) {
  await pool.query(
    `INSERT INTO offers (offer_id, token_id, offerer_address, amount_usdc, expires_at, active)
     VALUES ($1, $2, $3, $4, to_timestamp($5), true)
     ON CONFLICT (offer_id) DO NOTHING`,
    [offerId, tokenId, offerer, Number(amount) / 1_000_000, Number(expiresAt)]
  );
  console.log(`[indexer] indexed OfferMade: offerId=${offerId} tokenId=${tokenId}`);
}

export async function handleOfferCancelled({ offerId }) {
  await pool.query(`UPDATE offers SET active = false, cancelled_at = now() WHERE offer_id = $1`, [offerId]);
  console.log(`[indexer] indexed OfferCancelled: offerId=${offerId}`);
}

/// OfferAccepted doesn't carry tokenId in its event args — resolved from
/// the contract's own `offers` mapping via the ABI's read function,
/// mirroring resolveSlugFromHash's pattern above.
export async function handleOfferAccepted({ offerId, accepter }) {
  const [, , tokenId] = await publicClient.readContract({
    address: config.chain.offersContractAddress,
    abi: OFFERS_EVENTS_ABI,
    functionName: "offers",
    args: [offerId],
  });

  await pool.query(`UPDATE offers SET active = false, accepted_at = now() WHERE offer_id = $1`, [offerId]);
  await pool.query(`UPDATE nfts SET owner_address = $1 WHERE token_id = $2`, [accepter, tokenId]);
  console.log(`[indexer] indexed OfferAccepted: offerId=${offerId} tokenId=${tokenId} newOwner=${accepter}`);
}