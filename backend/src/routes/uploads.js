import { Router } from "express";
import { pool } from "../db.js";
import { config } from "../config.js";
import { consumeSignature } from "../auth.js";
import { pinFileToIpfs } from "../ipfs.js";
import { sniffImageType, ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, EXTENSION_FOR } from "../profile.js";

export const uploadsRouter = Router();

/// POST /api/uploads/image  (wallet-signed + x402-paid)
/// Body: the raw image bytes, with Content-Type image/png | image/jpeg | image/gif | image/webp (max 5 MB).
/// The bytes are checked against the real file signature (the header alone is not trusted; SVG is refused
/// because it can carry script), pinned to IPFS, and the ipfs:// URI is returned - use it as `image` in
/// prepare-metadata or as `imageUrl` / `bannerUrl` in a collection profile.
///
/// A per-agent rolling-24h quota (count and bytes) bounds how much anyone can make us pin.
uploadsRouter.post("/image", consumeSignature, async (req, res) => {
  const { agentId } = req.agentAuth;
  const buf = req.body;

  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return res.status(415).json({ error: `send the raw image bytes as the request body with Content-Type one of: ${ALLOWED_IMAGE_TYPES.join(", ")}` });
  }
  if (buf.length > MAX_IMAGE_BYTES) return res.status(413).json({ error: `image too large (max ${MAX_IMAGE_BYTES / 1024 / 1024} MB)` });

  const real = sniffImageType(buf);
  const declared = (req.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!real) return res.status(415).json({ error: "not a recognised image: only PNG, JPEG, GIF and WebP files are accepted (SVG is not allowed)" });
  if (real !== declared) return res.status(415).json({ error: `Content-Type says ${declared || "nothing"} but the file is actually ${real}` });

  if (!config.ipfs.pinataJwt) return res.status(503).json({ error: "image pinning is not configured on this server" });

  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS n, COALESCE(SUM(bytes), 0)::bigint AS total FROM uploads WHERE agent_id = $1 AND created_at > now() - interval '1 day'",
    [agentId]
  );
  if (rows[0].n >= config.uploads.maxPerDay || Number(rows[0].total) + buf.length > config.uploads.maxBytesPerDay) {
    return res.status(429).json({ error: `upload quota reached (${config.uploads.maxPerDay} files / ${Math.round(config.uploads.maxBytesPerDay / 1024 / 1024)} MB per 24 hours)` });
  }

  let cid;
  try {
    ({ cid } = await pinFileToIpfs(buf, `${agentId}-${Date.now()}.${EXTENSION_FOR[real]}`, real));
  } catch (err) {
    console.error("[uploads] pinning failed:", err.message);
    const status = err.status === 503 ? 503 : 502;
    return res.status(status).json({ error: err.status === 502 ? err.message : "could not pin the image to IPFS right now - try again shortly" });
  }

  await pool.query("INSERT INTO uploads (agent_id, cid, content_type, bytes) VALUES ($1, $2, $3, $4)", [agentId, cid, real, buf.length]);
  res.json({
    cid,
    uri: `ipfs://${cid}`,
    url: `${config.ipfs.gateways[0]}${cid}`,
    contentType: real,
    bytes: buf.length,
    note: "Use `uri` as the image in prepare-metadata, or as imageUrl / bannerUrl in your collection profile.",
  });
});
