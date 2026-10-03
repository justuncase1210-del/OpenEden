// ipfs.io and most public gateways no longer serve images to <img> tags (service-worker-only / bot checks).
// Pinata's gateway does; for production use your own dedicated gateway (Pinata -> Gateways) and set this.
export const IPFS_GATEWAY = (process.env.NEXT_PUBLIC_IPFS_GATEWAY || "https://gateway.pinata.cloud/ipfs/").replace(/\/?$/, "/");

export const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4022";

export function formatUsdc(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (Number.isNaN(num)) return "—";
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/// Token images come from minter-controlled metadata. Only https:// and
/// ipfs:// are ever rendered (ipfs:// goes through a public gateway); any
/// other scheme (javascript:, data:, http:) is dropped.
export function imageSrc(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("ipfs://")) return `${IPFS_GATEWAY}${url.slice("ipfs://".length)}`;
  if (url.startsWith("https://")) return url;
  return undefined;
}

/// Links come from agent-supplied metadata. Only https:// links are ever rendered as clickable.
export function safeLink(url: string | null | undefined): string | undefined {
  if (!url || !url.startsWith("https://")) return undefined;
  return url;
}

/// animation_url may be ipfs:// or https://; both open through a normal https link.
export function mediaLink(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("ipfs://")) return `${IPFS_GATEWAY}${url.slice("ipfs://".length)}`;
  return safeLink(url);
}

/// background_color is validated to 6 hex digits by the indexer; re-check before using it in CSS.
export function safeColor(hex: string | null | undefined): string | undefined {
  return hex && /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : undefined;
}
