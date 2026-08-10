import { publicClient } from "../chain/viemClient.js";
import { pool } from "../db.js";
import { config } from "../config.js";
import { AGENT_NFT_EVENTS_ABI, MARKETPLACE_EVENTS_ABI, COMMUNITY_REGISTRY_EVENTS_ABI, OFFERS_EVENTS_ABI } from "./abis.js";
import {
  handleMinted,
  handleListed,
  handleSold,
  handleCancelled,
  handleCommunityCreated,
  handleMemberJoined,
  handleMemberLeft,
  handleCollectionCreated,
  handleMintEnded,
  handleMintPriceUpdated,
  handleOfferMade,
  handleOfferCancelled,
  handleOfferAccepted,
} from "./handlers.js";

/// Watches AgentNFT/Marketplace/CommunityRegistry for the events that
/// actually change state, and keeps Postgres in sync.
///
/// RESUME LOGIC (added after initial build): each event stream's
/// progress is persisted in indexer_state, keyed by "address:eventName".
/// On restart, backfill resumes from (last persisted block + 1) instead
/// of always re-scanning from INDEXER_START_BLOCK — the fixed env value
/// is now only a genuine floor, used the FIRST time a given event stream
/// is ever seen. This was a known, documented shortcut before; on
/// mainnet with real activity, always-rescan-everything becomes slow and
/// eventually a real operational problem, so it's fixed here rather than
/// left for after launch.
export async function startIndexer() {
  const floorBlock = BigInt(config.chain.indexerStartBlock || 0);
  console.log(`[indexer] starting (floor block ${floorBlock}, resuming from persisted state where available)...`);

  await backfillAndWatch({ address: config.chain.nftContractAddress, abi: AGENT_NFT_EVENTS_ABI, eventName: "CollectionCreated", floorBlock, onLog: (log) => handleCollectionCreated(log.args) });
  await backfillAndWatch({ address: config.chain.nftContractAddress, abi: AGENT_NFT_EVENTS_ABI, eventName: "MintEnded", floorBlock, onLog: (log) => handleMintEnded(log.args) });
  await backfillAndWatch({ address: config.chain.nftContractAddress, abi: AGENT_NFT_EVENTS_ABI, eventName: "MintPriceUpdated", floorBlock, onLog: (log) => handleMintPriceUpdated(log.args) });
  await backfillAndWatch({ address: config.chain.nftContractAddress, abi: AGENT_NFT_EVENTS_ABI, eventName: "Minted", floorBlock, onLog: (log) => handleMinted(log.args) });

  await backfillAndWatch({ address: config.chain.marketplaceContractAddress, abi: MARKETPLACE_EVENTS_ABI, eventName: "Listed", floorBlock, onLog: (log) => handleListed(log.args) });
  await backfillAndWatch({ address: config.chain.marketplaceContractAddress, abi: MARKETPLACE_EVENTS_ABI, eventName: "Sold", floorBlock, onLog: (log) => handleSold(log.args) });
  await backfillAndWatch({ address: config.chain.marketplaceContractAddress, abi: MARKETPLACE_EVENTS_ABI, eventName: "Cancelled", floorBlock, onLog: (log) => handleCancelled(log.args) });

  await backfillAndWatch({ address: config.chain.communityRegistryAddress, abi: COMMUNITY_REGISTRY_EVENTS_ABI, eventName: "CommunityCreated", floorBlock, onLog: (log) => handleCommunityCreated(log.args) });
  await backfillAndWatch({ address: config.chain.communityRegistryAddress, abi: COMMUNITY_REGISTRY_EVENTS_ABI, eventName: "MemberJoined", floorBlock, onLog: (log) => handleMemberJoined(log.args) });
  await backfillAndWatch({ address: config.chain.communityRegistryAddress, abi: COMMUNITY_REGISTRY_EVENTS_ABI, eventName: "MemberLeft", floorBlock, onLog: (log) => handleMemberLeft(log.args) });

  await backfillAndWatch({ address: config.chain.offersContractAddress, abi: OFFERS_EVENTS_ABI, eventName: "OfferMade", floorBlock, onLog: (log) => handleOfferMade(log.args) });
  await backfillAndWatch({ address: config.chain.offersContractAddress, abi: OFFERS_EVENTS_ABI, eventName: "OfferCancelled", floorBlock, onLog: (log) => handleOfferCancelled(log.args) });
  await backfillAndWatch({ address: config.chain.offersContractAddress, abi: OFFERS_EVENTS_ABI, eventName: "OfferAccepted", floorBlock, onLog: (log) => handleOfferAccepted(log.args) });

  console.log("[indexer] backfill complete, watching for live events...");
}

async function getResumeBlock(eventKey, floorBlock) {
  const { rows } = await pool.query("SELECT last_processed_block FROM indexer_state WHERE event_key = $1", [eventKey]);
  if (rows.length === 0) return floorBlock;
  const persisted = BigInt(rows[0].last_processed_block) + 1n;
  return persisted > floorBlock ? persisted : floorBlock;
}

async function saveProgress(eventKey, block) {
  await pool.query(
    `INSERT INTO indexer_state (event_key, last_processed_block) VALUES ($1, $2)
     ON CONFLICT (event_key) DO UPDATE SET last_processed_block = GREATEST(indexer_state.last_processed_block, EXCLUDED.last_processed_block)`,
    [eventKey, block.toString()]
  );
}

async function backfillAndWatch({ address, abi, eventName, floorBlock, onLog }) {
  if (!address) {
    console.warn(`[indexer] skipping ${eventName} — contract address not configured`);
    return;
  }

  const eventKey = `${address.toLowerCase()}:${eventName}`;
  const startBlock = await getResumeBlock(eventKey, floorBlock);
  const latestBlock = await publicClient.getBlockNumber();
  const CHUNK_SIZE = BigInt(config.chain.indexerChunkSize || 1_900);

  if (startBlock > floorBlock) {
    console.log(`[indexer] ${eventName}: resuming from persisted block ${startBlock} (floor was ${floorBlock})`);
  }

  for (let from = startBlock; from <= latestBlock; from += CHUNK_SIZE) {
    const to = from + CHUNK_SIZE - 1n > latestBlock ? latestBlock : from + CHUNK_SIZE - 1n;
    const logs = await publicClient.getContractEvents({ address, abi, eventName, fromBlock: from, toBlock: to });
    for (const log of logs) {
      try {
        await onLog(log);
      } catch (err) {
        console.error(`[indexer] failed processing backfilled ${eventName} log:`, err);
      }
    }
    await saveProgress(eventKey, to);
  }

  publicClient.watchContractEvent({
    address,
    abi,
    eventName,
    onLogs: async (logs) => {
      for (const log of logs) {
        try {
          await onLog(log);
        } catch (err) {
          console.error(`[indexer] failed processing live ${eventName} log:`, err);
        }
        await saveProgress(eventKey, log.blockNumber);
      }
    },
    poll: true,
    pollingInterval: config.chain.indexerPollingIntervalMs,
  });
}