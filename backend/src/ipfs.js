import { config } from "./config.js";

const PINATA_PIN_JSON_URL = "https://api.pinata.cloud/pinning/pinJSONToIPFS";
const PINATA_PIN_FILE_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const FILEBASE_PIN_URL = "https://api.filebase.io/v1/ipfs/pins";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

function looksLikeValidCid(cid) {
  if (typeof cid !== "string" || cid.length === 0) return false;
  const isV0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid);
  const isV1 = /^b[A-Za-z2-7]{20,}$/.test(cid);
  return isV0 || isV1;
}

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

/// Pins the SAME CID Pinata already produced to Filebase too — a real
/// mirror of the exact same content-address, not just a second upload of
/// the same bytes (which could produce a DIFFERENT CID if the two
/// services wrap content differently, defeating the point of
/// redundancy). Deliberately fire-and-forget, non-blocking: if this
/// fails, the primary Pinata pin is still completely valid and minting
/// should not be held up waiting on a backup copy.
async function backupPinToFilebase(cid) {
  if (!config.ipfs.filebaseToken) {
    console.warn(`[ipfs] FILEBASE_PINNING_TOKEN not configured — skipping backup pin for ${cid}. Pinata remains a single point of failure until this is set.`);
    return;
  }
  try {
    const res = await fetch(FILEBASE_PIN_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.ipfs.filebaseToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ cid, name: `openeden-${cid}` }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${text}`);
    }
    console.log(`[ipfs] backup-pinned ${cid} to Filebase`);
  } catch (err) {
    console.warn(`[ipfs] Filebase backup pin failed for ${cid} (non-blocking, Pinata copy still valid):`, err.message);
  }
}

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

      const cid = data.IpfsHash;
      backupPinToFilebase(cid); // deliberately not awaited — see comment above

      return { cid, tokenUri: `ipfs://${cid}` };
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
/// Pins a binary file (an uploaded image) to IPFS via Pinata and mirrors it to Filebase.
/// Needs a Pinata key that is allowed to call pinFileToIPFS (separate from pinJSONToIPFS).
export async function pinFileToIpfs(buffer, filename, contentType) {
  if (!config.ipfs.pinataJwt) throw Object.assign(new Error("PINATA_JWT not configured"), { status: 503 });

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const form = new FormData();
      form.append("file", new Blob([buffer], { type: contentType }), filename);
      form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
      form.append("pinataMetadata", JSON.stringify({ name: `openeden-${filename}` }));

      const res = await fetch(PINATA_PIN_FILE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.ipfs.pinataJwt}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) throw new Error(`Pinata returned ${res.status} - retrying`);
        const hint = res.status === 401 || res.status === 403 ? " (the Pinata API key needs the pinFileToIPFS permission)" : "";
        throw Object.assign(new Error(`Pinata rejected the file: HTTP ${res.status}${hint}`), { permanent: true, status: 502 });
      }
      const data = await res.json();
      if (!looksLikeValidCid(data.IpfsHash)) {
        throw Object.assign(new Error("Pinata returned a response without a valid-looking CID"), { permanent: true, status: 502 });
      }
      backupPinToFilebase(data.IpfsHash); // fire-and-forget mirror
      return { cid: data.IpfsHash };
    } catch (err) {
      lastError = err;
      if (err.permanent || attempt === MAX_RETRIES) break;
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}
