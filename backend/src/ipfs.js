import { config } from "./config.js";

const PINATA_PIN_JSON_URL = "https://api.pinata.cloud/pinning/pinJSONToIPFS";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

/// Basic sanity check, not a full CID parser — catches "Pinata returned
/// something that clearly isn't a CID" (empty string, error text,
/// truncated response), not a guarantee of correctness.
function looksLikeValidCid(cid) {
  if (typeof cid !== "string" || cid.length === 0) return false;
  const isV0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid);
  const isV1 = /^b[A-Za-z2-7]{20,}$/.test(cid);
  return isV0 || isV1;
}

/// Validates metadata BEFORE attempting to pin — rejecting bad input
/// here is cheap; a bad pin can't be un-minted once an agent uses the
/// resulting tokenURI. Field names match the OpenSea metadata standard,
/// since that's what wallets/marketplaces expect.
export function validateMetadataSchema({ name, description, image, attributes }) {
  const errors = [];
  if (typeof name !== "string" || name.length === 0) errors.push("name must be a non-empty string");
  if (name && name.length > 200) errors.push("name too long (max 200 chars)");
  if (description !== undefined && description !== null && typeof description !== "string") errors.push("description must be a string");
  if (description && description.length > 2000) errors.push("description too long (max 2000 chars)");
  if (typeof image !== "string" || image.length === 0) errors.push("image must be a non-empty string (URL or ipfs://)");
  if (image && image.length > 2000) errors.push("image too long (max 2000 chars)");

  if (attributes !== undefined) {
    if (!Array.isArray(attributes)) {
      errors.push("attributes must be an array");
    } else {
      if (attributes.length > 50) errors.push("too many attributes (max 50)");
      attributes.forEach((attr, i) => {
        if (typeof attr !== "object" || attr === null) {
          errors.push(`attributes[${i}] must be an object`);
          return;
        }
        if (typeof attr.trait_type !== "string" || attr.trait_type.length === 0) {
          errors.push(`attributes[${i}].trait_type must be a non-empty string`);
        }
        if (attr.value === undefined || attr.value === null || attr.value === "") {
          errors.push(`attributes[${i}].value must be present`);
        }
      });
    }
  }
  return errors;
}

/// Pins validated metadata to IPFS via Pinata, retrying on transient
/// failures (network errors, 5xx, rate limits) — not on 4xx auth/
/// validation errors, which won't be fixed by retrying.
export async function pinMetadataToIpfs(metadata) {
  if (!config.ipfs.pinataJwt) {
    throw new Error("PINATA_JWT not configured — cannot pin metadata");
  }

  const body = {
    pinataOptions: { cidVersion: 1 },
    pinataMetadata: { name: `${metadata.name || "nft"}-metadata` },
    pinataContent: metadata,
  };

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(PINATA_PIN_JSON_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.ipfs.pinataJwt}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) throw new Error(`Pinata returned ${res.status} — retrying`);
        const text = await res.text().catch(() => "");
        throw Object.assign(new Error(`Pinata pin failed: ${res.status} ${text}`), { permanent: true });
      }

      const data = await res.json();
      if (!looksLikeValidCid(data.IpfsHash)) {
        throw Object.assign(new Error(`Pinata returned a response without a valid-looking CID: ${JSON.stringify(data)}`), { permanent: true });
      }

      return { cid: data.IpfsHash, tokenUri: `ipfs://${data.IpfsHash}` };
    } catch (err) {
      lastError = err;
      if (err.permanent || attempt === MAX_RETRIES) break;
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`[ipfs] pin attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delay}ms:`, err.message);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}