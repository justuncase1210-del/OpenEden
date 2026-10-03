import crypto from "node:crypto";
import { config } from "../config.js";
import { pool } from "../db.js";
import { sanitizeAttributes } from "../rarity.js";
import { validateExtraMetadata } from "../profile.js";

const MAX_METADATA_BYTES = 100_000;
const FETCH_TIMEOUT_MS = 15_000;
// CIDv0 or CIDv1 (base32), optionally followed by a plain sub-path. Anything
// else (path traversal, query strings, credentials, other hosts) is refused
// BEFORE it can be concatenated into a gateway URL.
const IPFS_PATH = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-zA-Z2-7]{20,})(\/[A-Za-z0-9._~-]{1,100}){0,4}$/;

export function ipfsPathFromUri(uri) {
  if (typeof uri !== "string" || !uri.startsWith("ipfs://")) return null;
  const path = uri.slice("ipfs://".length);
  return IPFS_PATH.test(path) ? path : null;
}

/// Only https:// and ipfs:// image references are ever stored/displayed.
/// (http:, javascript:, data:, file: etc. are dropped.)
export function safeImageUrl(value) {
  if (typeof value !== "string") return null;
  const v = value.slice(0, 2000);
  return v.startsWith("https://") || v.startsWith("ipfs://") ? v : null;
}

// ------------------------------------------------------------------ content verification
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str.toLowerCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/// Parses a base32 CIDv1 ("b...") into { codec, hashCode, digest }, or null if it isn't one.
export function parseCidV1(cid) {
  if (typeof cid !== "string" || !cid.startsWith("b")) return null;
  const bytes = base32Decode(cid.slice(1));
  if (!bytes || bytes.length < 4 || bytes[0] !== 0x01) return null;
  const hashLen = bytes[3];
  if (bytes.length !== 4 + hashLen) return null;
  return { codec: bytes[1], hashCode: bytes[2], digest: bytes.subarray(4) };
}

/// Does `bytes` hash to the digest inside this CID? Returns true / false, or null when the CID isn't a
/// single-block sha2-256 raw CIDv1 (the kind Pinata issues for small JSON), i.e. when it can't be checked.
/// With this check the gateway that served the bytes does not need to be trusted at all.
export function verifyRawBlock(cid, bytes) {
  const parsed = parseCidV1(cid);
  if (!parsed || parsed.codec !== 0x55 || parsed.hashCode !== 0x12 || parsed.digest.length !== 32) return null;
  return crypto.createHash("sha256").update(bytes).digest().equals(parsed.digest);
}

async function readCapped(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_METADATA_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("metadata response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ metadata fetching
function shape(metadata) {
  const attrs = sanitizeAttributes(metadata.attributes);
  const extra = validateExtraMetadata(metadata).values; // invalid extras are dropped, never stored
  return {
    ok: true,
    name: typeof metadata.name === "string" ? metadata.name.slice(0, 200) : null,
    description: typeof metadata.description === "string" ? metadata.description.slice(0, 2000) : null,
    imageUrl: safeImageUrl(metadata.image),
    attributes: attrs && attrs.length ? attrs : null,
    externalUrl: extra.external_url ?? null,
    animationUrl: extra.animation_url ?? null,
    backgroundColor: extra.background_color ?? null,
  };
}

const EMPTY = { ok: false, name: null, description: null, imageUrl: null, attributes: null, externalUrl: null, animationUrl: null, backgroundColor: null };

/// Fetches + sanitises token metadata. Never throws; `ok` says whether metadata was actually obtained
/// (so callers can retry later when it was not).
///  1. Metadata we pinned ourselves via prepare-metadata is read from our own database - no gateway needed.
///  2. Otherwise only the configured gateways are contacted (never a host taken from the minter-controlled
///     tokenURI, so it cannot be pointed at internal infrastructure), using the trustless "raw block"
///     request that today's public gateways still honour, and the bytes are checked against the CID.
export async function fetchTokenMetadata(tokenURI) {
  const path = ipfsPathFromUri(tokenURI);
  if (!path) return { ...EMPTY };
  const hasSubPath = path.includes("/");
  const root = path.split("/")[0];

  if (!hasSubPath) {
    try {
      const { rows } = await pool.query("SELECT body FROM pinned_metadata WHERE cid = $1", [root]);
      if (rows.length > 0 && rows[0].body && typeof rows[0].body === "object") return shape(rows[0].body);
    } catch (err) {
      console.warn(`[indexer] pinned-metadata cache lookup failed for ${root}: ${err.message}`);
    }
  }

  const headers = hasSubPath ? { Accept: "application/json" } : { Accept: "application/vnd.ipld.raw, application/json;q=0.5" };
  for (const gateway of config.ipfs.gateways) {
    try {
      const res = await fetch(gateway + path, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers });
      if (!res.ok) { console.warn(`[indexer] ${gateway} answered HTTP ${res.status} for ${path}`); continue; }
      const bytes = await readCapped(res);
      if (!hasSubPath && verifyRawBlock(root, bytes) === false) {
        console.warn(`[indexer] ${gateway} returned bytes that do NOT match CID ${root} - ignoring them`);
        continue;
      }
      const metadata = JSON.parse(bytes.toString("utf8"));
      if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) continue;
      return shape(metadata);
    } catch (err) {
      console.warn(`[indexer] metadata fetch via ${gateway} failed for ${path}: ${err.message}`);
    }
  }
  return { ...EMPTY };
}

/// NFTs whose metadata could not be fetched at mint time (gateway down, content not yet propagated) are
/// retried here with a growing delay, instead of staying blank forever.
export async function retryMissingMetadata(limit = 10) {
  const { rows } = await pool.query(
    `SELECT token_id, token_uri, metadata_attempts FROM nfts
     WHERE name IS NULL AND image_url IS NULL AND token_uri LIKE 'ipfs://%'
       AND metadata_attempts < 12 AND (metadata_next_try_at IS NULL OR metadata_next_try_at <= now())
     ORDER BY token_id LIMIT $1`,
    [limit]
  );
  let fixed = 0;
  for (const row of rows) {
    const meta = await fetchTokenMetadata(row.token_uri);
    if (meta.ok) {
      await pool.query(
        `UPDATE nfts SET name = $2, description = $3, image_url = $4, attributes = $5::jsonb,
                external_url = $6, animation_url = $7, background_color = $8, metadata_next_try_at = NULL
         WHERE token_id = $1`,
        [row.token_id, meta.name, meta.description, meta.imageUrl, meta.attributes ? JSON.stringify(meta.attributes) : null, meta.externalUrl, meta.animationUrl, meta.backgroundColor]
      );
      fixed++;
    } else {
      const attempts = row.metadata_attempts + 1;
      await pool.query(
        "UPDATE nfts SET metadata_attempts = $2, metadata_next_try_at = now() + ($3 || ' minutes')::interval WHERE token_id = $1",
        [row.token_id, attempts, String(attempts * 2)]
      );
    }
  }
  if (rows.length > 0) console.log(`[indexer] metadata retry: ${fixed}/${rows.length} filled in`);
  return fixed;
}
