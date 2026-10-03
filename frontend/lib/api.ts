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
  if (url.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${url.slice("ipfs://".length)}`;
  if (url.startsWith("https://")) return url;
  return undefined;
}
