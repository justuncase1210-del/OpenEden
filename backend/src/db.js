import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.db.url });

/// Off-chain indexed data. The chain remains the source of truth for
/// ownership/listings/community-membership (see the contracts) — this
/// schema mirrors on-chain events for fast querying (marketplace UI can't
/// efficiently ask "show me all active listings under $50" directly from
/// a contract) plus stores things that genuinely don't belong on-chain
/// (community post text, NFT metadata cache, agent profile info).
///
/// Populated by backend/src/indexer/ (watches Minted/Listed/Sold/
/// Cancelled/CommunityCreated/MemberJoined/MemberLeft events) — see that
/// directory for the actual write logic. `name`/`description` on
/// `communities` are nullable because the indexer creates a row from
/// on-chain CommunityCreated (which has no name) before
/// /api/community/metadata potentially fills it in — a community can
/// legitimately exist with no name yet.
export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      wallet_address TEXT,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS collections (
      collection_id BIGINT PRIMARY KEY,
      contract_address TEXT NOT NULL,
      creator_agent_id TEXT REFERENCES agents(agent_id),
      creator_wallet TEXT,
      max_supply BIGINT NOT NULL,
      minted_count BIGINT DEFAULT 0,
      mint_ended BOOLEAN DEFAULT false,
      verified BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE collections ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT false;
    ALTER TABLE collections ADD COLUMN IF NOT EXISTS mint_price_usdc NUMERIC(20, 6) DEFAULT 0;

    CREATE TABLE IF NOT EXISTS nfts (
      token_id BIGINT PRIMARY KEY,
      contract_address TEXT NOT NULL,
      collection_id BIGINT,
      owner_address TEXT NOT NULL,
      creator_agent_id TEXT REFERENCES agents(agent_id),
      token_uri TEXT NOT NULL,
      name TEXT,
      description TEXT,
      image_url TEXT,
      attributes JSONB,
      community_slug TEXT,
      minted_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE nfts ADD COLUMN IF NOT EXISTS attributes JSONB;

    CREATE TABLE IF NOT EXISTS listings (
      listing_id BIGINT PRIMARY KEY,
      token_id BIGINT NOT NULL REFERENCES nfts(token_id),
      seller_address TEXT NOT NULL,
      buyer_address TEXT,
      price_usdc NUMERIC(20, 6) NOT NULL,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now(),
      sold_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ
    );
    ALTER TABLE listings ADD COLUMN IF NOT EXISTS buyer_address TEXT;

    CREATE TABLE IF NOT EXISTS offers (
      offer_id BIGINT PRIMARY KEY,
      token_id BIGINT NOT NULL REFERENCES nfts(token_id),
      offerer_address TEXT NOT NULL,
      amount_usdc NUMERIC(20, 6) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now(),
      accepted_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS watchlist_items (
      id SERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(agent_id),
      token_id BIGINT REFERENCES nfts(token_id),
      collection_id BIGINT REFERENCES collections(collection_id),
      created_at TIMESTAMPTZ DEFAULT now(),
      CONSTRAINT watchlist_exactly_one_target CHECK (
        (token_id IS NOT NULL AND collection_id IS NULL) OR
        (token_id IS NULL AND collection_id IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS communities (
      slug TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      creator_agent_id TEXT REFERENCES agents(agent_id),
      member_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS community_posts (
      id SERIAL PRIMARY KEY,
      community_slug TEXT REFERENCES communities(slug),
      author_agent_id TEXT REFERENCES agents(agent_id),
      body TEXT NOT NULL,
      token_id BIGINT REFERENCES nfts(token_id),
      created_at TIMESTAMPTZ DEFAULT now()
    );

    -- Tracks how far each on-chain event stream has been indexed, so a
    -- restart resumes from here instead of re-scanning the entire chain
    -- history from INDEXER_START_BLOCK every time. Added during
    -- mainnet-readiness review — a known, documented shortcut before.
    CREATE TABLE IF NOT EXISTS indexer_state (
      event_key TEXT PRIMARY KEY,
      last_processed_block BIGINT NOT NULL
    );

    -- Indexes on the columns actually filtered/joined on throughout
    -- routes/ and indexer/ — previously missing entirely (every query
    -- beyond a primary-key lookup was a full table scan). Found during
    -- the production-hardening review, not present originally.
    CREATE INDEX IF NOT EXISTS idx_nfts_owner_address ON nfts(owner_address);
    CREATE INDEX IF NOT EXISTS idx_nfts_creator_agent_id ON nfts(creator_agent_id);
    CREATE INDEX IF NOT EXISTS idx_nfts_collection_id ON nfts(collection_id);
    CREATE INDEX IF NOT EXISTS idx_nfts_community_slug ON nfts(community_slug);
    CREATE INDEX IF NOT EXISTS idx_listings_token_id ON listings(token_id);
    CREATE INDEX IF NOT EXISTS idx_listings_active ON listings(active) WHERE active = true;
    CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_address);
    CREATE INDEX IF NOT EXISTS idx_offers_token_id ON offers(token_id);
    CREATE INDEX IF NOT EXISTS idx_offers_active_expires ON offers(active, expires_at) WHERE active = true;
    CREATE INDEX IF NOT EXISTS idx_community_posts_slug ON community_posts(community_slug);
    CREATE INDEX IF NOT EXISTS idx_community_posts_author_created ON community_posts(author_agent_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_collections_mint_ended ON collections(mint_ended);
    CREATE INDEX IF NOT EXISTS idx_agents_wallet_address ON agents(wallet_address);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_unique_token ON watchlist_items(agent_id, token_id) WHERE token_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_unique_collection ON watchlist_items(agent_id, collection_id) WHERE collection_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_watchlist_agent ON watchlist_items(agent_id);
  `);
  console.log("[db] schema ready");
}