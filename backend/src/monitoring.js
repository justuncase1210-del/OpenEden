import { pool } from "./db.js";
import { publicClient } from "./chain/viemClient.js";
import { config } from "./config.js";

const CHECK_INTERVAL_MS = 60_000;
const MAX_ACCEPTABLE_LAG_BLOCKS = 500n;

let lastAlertSentAt = {};
const ALERT_COOLDOWN_MS = 15 * 60_000;

function errorDetail(err) {
  // pg connection errors and some others don't always populate
  // .message the way a plain Error does - fall back to the whole
  // stringified object so an alert is never blank.
  return err?.message || err?.code || String(err) || "unknown error (no message on error object)";
}

async function sendDiscordAlert(title, detail) {
  if (!config.monitoring.discordWebhookUrl) return;

  const now = Date.now();
  if (lastAlertSentAt[title] && now - lastAlertSentAt[title] < ALERT_COOLDOWN_MS) return;
  lastAlertSentAt[title] = now;

  try {
    await fetch(config.monitoring.discordWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{ title: `OpenEden alert: ${title}`, description: detail, color: 15158332, timestamp: new Date().toISOString() }],
      }),
    });
  } catch (err) {
    console.error("[monitoring] failed to send Discord alert:", errorDetail(err));
  }
}

async function checkDatabase() {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (err) {
    const detail = errorDetail(err);
    console.error("[monitoring] database check failed:", detail);
    await sendDiscordAlert("Database unreachable", detail);
    return false;
  }
}

/// Split into two independent try/catch blocks so a Postgres failure
/// and an RPC failure are never confused for each other - a real bug
/// caught during testing, where a DB outage was misreported as an RPC
/// problem because both calls originally shared one catch block.
async function checkRpcAndIndexerLag() {
  let latestBlock;
  try {
    latestBlock = await publicClient.getBlockNumber();
  } catch (err) {
    const detail = errorDetail(err);
    console.error("[monitoring] RPC check failed:", detail);
    await sendDiscordAlert("RPC unreachable", detail);
    return false;
  }

  try {
    const { rows } = await pool.query("SELECT MAX(last_processed_block) AS max_block FROM indexer_state");
    const indexedBlock = rows[0].max_block ? BigInt(rows[0].max_block) : 0n;

    const lag = latestBlock - indexedBlock;
    if (lag > MAX_ACCEPTABLE_LAG_BLOCKS) {
      console.warn(`[monitoring] indexer lag is ${lag} blocks (chain at ${latestBlock}, indexed to ${indexedBlock})`);
      await sendDiscordAlert("Indexer falling behind", `Lag: ${lag} blocks. Chain head: ${latestBlock}. Indexed: ${indexedBlock}.`);
    }
    return true;
  } catch (err) {
    // This is a DB failure, not an RPC one - checkDatabase() above will
    // already have alerted on it, so just log here without a duplicate alert.
    console.error("[monitoring] indexer lag check failed (database issue, see 'database unreachable' alert above):", errorDetail(err));
    return false;
  }
}

export function startWatchdog() {
  console.log(`[monitoring] watchdog started, checking every ${CHECK_INTERVAL_MS / 1000}s`);
  setInterval(async () => {
    await checkDatabase();
    await checkRpcAndIndexerLag();
  }, CHECK_INTERVAL_MS);
}

export async function alertOnCrash(err) {
  await sendDiscordAlert("Unhandled error", String(err?.stack || err));
}