/// Input validation for collection profiles, extra NFT metadata fields and uploaded images.
/// Everything here is pure (no I/O) so it is unit-testable.
///
/// Why so strict: every one of these values is chosen by an agent and then shown to human
/// visitors (and fetched by their browsers). Only https:// and ipfs:// URLs are ever accepted
/// (never http:, javascript:, data:, file:), and uploaded images are checked by their real
/// content - SVG is refused outright because it can carry script.

const HTTPS_OR_IPFS = (v, max) => typeof v === "string" && v.length <= max && (v.startsWith("https://") || v.startsWith("ipfs://"));
const HTTPS_ONLY = (v, max) => typeof v === "string" && v.length <= max && v.startsWith("https://");
const NO_CONTROL_CHARS = /[\u0000-\u001f\u007f]/; // newlines etc. do not belong in names/URLs

export function hasControlChars(v) {
  return typeof v === "string" && NO_CONTROL_CHARS.test(v);
}

function urlOk(v, max, httpsOnly) {
  if (hasControlChars(v) || /\s/.test(v)) return false;
  if (!(httpsOnly ? HTTPS_ONLY(v, max) : HTTPS_OR_IPFS(v, max))) return false;
  if (v.startsWith("https://")) {
    try {
      const u = new URL(v);
      if (!u.hostname || u.username || u.password) return false; // no https://user:pass@host tricks
    } catch {
      return false;
    }
  }
  return true;
}

/// Validate a collection-profile update. Returns { errors, values } where `values` contains only the
/// fields the caller sent (so partial updates work). `null` or "" clears an optional field.
export function validateProfile(body) {
  const errors = [];
  const values = {};
  const b = body && typeof body === "object" ? body : {};

  if ("name" in b) {
    if (typeof b.name !== "string" || b.name.trim().length < 1 || b.name.length > 100 || hasControlChars(b.name)) errors.push("name must be 1-100 characters (no line breaks)");
    else values.name = b.name.trim();
  }
  if ("symbol" in b) {
    if (b.symbol === null || b.symbol === "") values.symbol = null;
    else if (typeof b.symbol !== "string" || !/^[A-Za-z0-9]{1,12}$/.test(b.symbol)) errors.push("symbol must be 1-12 letters or digits");
    else values.symbol = b.symbol.toUpperCase();
  }
  if ("description" in b) {
    if (b.description === null || b.description === "") values.description = null;
    else if (typeof b.description !== "string" || b.description.length > 2000) errors.push("description must be a string of at most 2000 characters");
    else values.description = b.description;
  }
  for (const [field, key, httpsOnly, max] of [["imageUrl", "image_url", false, 2000], ["bannerUrl", "banner_url", false, 2000], ["externalUrl", "external_url", true, 500]]) {
    if (field in b) {
      const v = b[field];
      if (v === null || v === "") values[key] = null;
      else if (!urlOk(v, max, httpsOnly)) errors.push(`${field} must be ${httpsOnly ? "an https://" : "an https:// or ipfs://"} URL (max ${max} characters)`);
      else values[key] = v;
    }
  }
  if (errors.length === 0 && Object.keys(values).length === 0) errors.push("nothing to update: send at least one of name, symbol, description, imageUrl, bannerUrl, externalUrl");
  return { errors, values };
}

/// Extra standard NFT metadata fields (OpenSea-style). Returns { errors, values } with only valid, present fields.
export function validateExtraMetadata(body) {
  const errors = [];
  const values = {};
  const b = body && typeof body === "object" ? body : {};

  if (b.external_url !== undefined && b.external_url !== null && b.external_url !== "") {
    if (!urlOk(b.external_url, 500, true)) errors.push("external_url must be an https:// URL (max 500 characters)");
    else values.external_url = b.external_url;
  }
  if (b.animation_url !== undefined && b.animation_url !== null && b.animation_url !== "") {
    if (!urlOk(b.animation_url, 2000, false)) errors.push("animation_url must be an https:// or ipfs:// URL (max 2000 characters)");
    else values.animation_url = b.animation_url;
  }
  if (b.background_color !== undefined && b.background_color !== null && b.background_color !== "") {
    const hex = typeof b.background_color === "string" ? b.background_color.replace(/^#/, "") : "";
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) errors.push("background_color must be a 6-digit hex colour like 1a2b3c");
    else values.background_color = hex.toLowerCase();
  }
  return { errors, values };
}

/// Identify an image by its real bytes. Returns the MIME type, or null if it is not a PNG, JPEG, GIF or WebP.
/// (SVG is intentionally unsupported: it can contain scripts.)
export function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG" && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  const head6 = buf.toString("latin1", 0, 6);
  if (head6 === "GIF87a" || head6 === "GIF89a") return "image/gif";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const EXTENSION_FOR = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
