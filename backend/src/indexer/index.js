import { parseEventLogs } from "viem";
import { publicClient } from "../chain/viemClient.js";
import { pool } from "../db.js";
import { config } from "../config.js";
import { AGENT_NFT_EVENTS_ABI, MARKETPLACE_EVENTS_ABI, COMMUNITY_REGISTRY_EVENTS_ABI, OFFERS_EVENTS_ABI } from "./abis.js";
import { HANDLERS } from "./handlers.js";
import { alertOnCrash } from "../monitoring.js";

/// ONE ordered event stream across all four contracts.
///
/// The previous design ran an independent backfill + watcher per event
/// type, which meant a Sold could be applied before the Minted it
/// belongs to, blocks mined while a long backfill ran were never seen,
/// one stream's failure silently killed every later stream, and a failed
/// handler was swallowed while progress was still saved (permanent data
/// loss). Here:
///   - logs for every contract are fetched together and applied in
///     (blockNumber, logIndex) order;
///   - progress is persisted ONLY after a whole chunk applied cleanly -
///     any failure retries the same chunk (handlers are idempotent);
///   - only blocks `indexerConfirmations` deep are read (shallow-reorg
///     defense), and polling continuously from the persisted cursor means
///     there is no backfill->watch gap;
///   - handlers get the block's real timestamp.
const STATE_KEY = "all-events-v2";

const EVENTS_ABI = [
  ...AGENT_NFT_EVENTS_ABI,
  ...MARKETPLACE_EVENTS_ABI,
  ...COMMUNITY_REGISTRY_EVENTS_ABI,
  ...OFFERS_EVENTS_ABI,
].filter((item) => item.type === "event");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getCursor(floorBlock) {
  const { rows } = await pool.query("SELECT last_processed_block FROM indexer_state WHERE event_key = $1", [STATE_KEY]);
  // First run of this indexer version deliberately ignores the legacy
  // per-event cursors and replays from the floor: the handlers are
  // idempotent, and community_members / buyer_address / block timestamps
  // only become correct by re-reading history once.
  if (rows.length === 0) return floorBlock;
  const next = BigInt(rows[0].last_processed_block) + 1n;
  return next > floorBlock ? next : floorBlock;
}

async function saveProgress(block) {
  await pool.query(
    `INSERT INTO indexer_state (event_key, last_processed_block) VALUES ($1, $2)
     ON CONFLICT (event_key) DO UPDATE SET last_processed_block = GREATEST(indexer_state.last_processed_block, EXCLUDED.last_processed_block)`,
    [STATE_KEY, block.toString()]
  );
}

const blockTimeCache = new Map();
async function getBlockTime(blockNumber) {
  const key = blockNumber.toString();
  if (blockTimeCache.has(key)) return blockTimeCache.get(key);
  const block = await publicClient.getBlock({ blockNumber });
  const date = new Date(Number(block.timestamp) * 1000);
  if (blockTimeCache.size > 500) blockTimeCache.clear();
  blockTimeCache.set(key, date);
  return date;
}

async function applyEvent(event) {
  const handler = HANDLERS[event.eventName];
  if (!handler) return;
  const ctx = { timestamp: await getBlockTime(event.blockNumber), blockNumber: event.blockNumber };

  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await handler(event.args, ctx);
      return;
    } catch (err) {
      lastErr = err;
      // 23503 = foreign-key violation: the row this event refers to
      // (e.g. an agent that exists on-chain but not in Postgres) will
      // never appear by retrying. Skip it LOUDLY rather than wedge the
      // whole indexer behind one poison event.
      if (err?.code === "23503") {
        console.error(`[indexer] SKIPPING ${event.eventName} at block ${event.blockNumber} (foreign-key violation - referenced row missing):`, err.detail || err.message);
        return;
      }
      await sleep(300 * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}

export async function startIndexer() {
  const addresses = [
    config.chain.nftContractAddress,
    config.chain.marketplaceContractAddress,
    config.chain.communityRegistryAddress,
    config.chain.offersContractAddress,
  ].filter(Boolean);

  if (addresses.length === 0) {
    console.warn("[indexer] no contract addresses configured - nothing to index");
    return;
  }

  const floorBlock = BigInt(config.chain.indexerStartBlock || 0);
  let chunkSize = BigInt(config.chain.indexerChunkSize || 900);
  const chunkDelayMs = parseInt(config.chain.indexerChunkDelayMs || "0", 10);
  const confirmations = BigInt(config.chain.indexerConfirmations);

  let next = await getCursor(floorBlock);
  console.log(`[indexer] starting at block ${next} (floor ${floorBlock}, ${confirmations} confirmations, ${addresses.length} contracts)`);

  // Runs forever; every failure is caught and retried with backoff so one
  // bad RPC call or DB blip can never silently stop indexing.
  (async () => {
    let backoff = 1_000;
    for (;;) {
      try {
        const head = await publicClient.getBlockNumber();
        const safeHead = head - confirmations;
        if (next > safeHead) {
          await sleep(config.chain.indexerPollingIntervalMs);
          continue;
        }

        const to = next + chunkSize - 1n > safeHead ? safeHead : next + chunkSize - 1n;
        const logs = await publicClient.getLogs({ address: addresses, fromBlock: next, toBlock: to });
        const events = parseEventLogs({ abi: EVENTS_ABI, logs });
        events.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));

        for (const event of events) await applyEvent(event);

        await saveProgress(to);
        if (events.length > 0) console.log(`[indexer] blocks ${next}-${to}: applied ${events.length} event(s)`);
        next = to + 1n;
        backoff = 1_000;

        if (to < safeHead) {
          if (chunkDelayMs > 0) await sleep(chunkDelayMs);
          continue; // still catching up - no idle wait
        }
        await sleep(config.chain.indexerPollingIntervalMs);
      } catch (err) {
        const detail = [err?.shortMessage, err?.details, err?.message].filter(Boolean).join(" | ");
        // Public RPCs cap eth_getLogs ranges ("limited to a 1,000 range"). Learn the cap and
        // shrink the chunk instead of failing forever.
        const cap = detail.match(/limited to (?:a )?([\d,]+)(?: block)? range/i) || detail.match(/range (?:is )?(?:too large|exceed\w*)[^\d]*([\d,]+)/i);
        if (cap) {
          const limit = BigInt(cap[1].replace(/,/g, ""));
          const smaller = limit > 100n ? (limit * 9n) / 10n : limit;
          if (smaller < chunkSize) {
            chunkSize = smaller;
            console.warn(`[indexer] RPC caps eth_getLogs at ${limit} blocks - chunk size reduced to ${chunkSize}`);
            continue;
          }
        }
        console.error(`[indexer] chunk starting at block ${next} failed, retrying in ${backoff}ms:`, detail.slice(0, 300) || err);
        if (backoff >= 30_000) alertOnCrash(err);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  })();
}
