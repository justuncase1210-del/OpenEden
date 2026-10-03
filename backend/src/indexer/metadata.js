import { config } from "../config.js";
import { sanitizeAttributes } from "../rarity.js";
import { validateExtraMetadata } from "../profile.js";

const MAX_METADATA_BYTES = 100_000;
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
  return Buffer.concat(chunks).toString("utf8");
}

/// Fetches + sanitises token metadata. Returns null fields (never throws)
/// when the URI isn't a well-formed ipfs:// URI or no gateway answers.
/// Only the configured IPFS gateways are ever contacted - never a host
/// taken from the (minter-controlled) tokenURI - so this cannot be pointed
/// at internal infrastructure (SSRF).
export async function fetchTokenMetadata(tokenURI) {
  const empty = { name: null, description: null, imageUrl: null, attributes: null, externalUrl: null, animationUrl: null, backgroundColor: null };
  const path = ipfsPathFromUri(tokenURI);
  if (!path) return empty;

  for (const gateway of config.ipfs.gateways) {
    try {
      const res = await fetch(gateway + path, { signal: AbortSignal.timeout(5000), headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const metadata = JSON.parse(await readCapped(res));
      if (typeof metadata !== "object" || metadata === null) continue;
      const attrs = sanitizeAttributes(metadata.attributes);
      const extra = validateExtraMetadata(metadata).values; // invalid extras are dropped, never stored
      return {
        name: typeof metadata.name === "string" ? metadata.name.slice(0, 200) : null,
        description: typeof metadata.description === "string" ? metadata.description.slice(0, 2000) : null,
        imageUrl: safeImageUrl(metadata.image),
        attributes: attrs && attrs.length ? attrs : null,
        externalUrl: extra.external_url ?? null,
        animationUrl: extra.animation_url ?? null,
        backgroundColor: extra.background_color ?? null,
      };
    } catch (err) {
      console.warn(`[indexer] metadata fetch via ${gateway} failed for ${path}: ${err.message}`);
    }
  }
  return empty;
}
