/// Trait-frequency / rarity math, shared by GET /api/collections/:id/traits
/// and the estimate_rarity MCP tool.
///
/// Trait names and values come from minter-controlled metadata. The old
/// implementation used plain objects keyed by those strings, so a trait
/// named "__proto__" (or "constructor") wrote onto Object.prototype and
/// polluted the whole server process. Everything here is Map-based, and
/// attributes are re-validated defensively even though the indexer
/// already sanitises them on the way in.
export function sanitizeAttributes(attributes) {
  if (!Array.isArray(attributes)) return null;
  const out = [];
  for (const attr of attributes.slice(0, 50)) {
    if (typeof attr !== "object" || attr === null) continue;
    const { trait_type: traitType, value } = attr;
    if (typeof traitType !== "string" || traitType.length === 0 || traitType.length > 100) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    const v = String(value);
    if (v.length === 0 || v.length > 200) continue;
    out.push({ trait_type: traitType, value: v });
  }
  return out;
}

export function computeRarity(rows) {
  const traitCounts = new Map(); // trait_type -> Map(value -> count)
  const cleaned = rows.map((row) => ({ tokenId: String(row.token_id), attrs: sanitizeAttributes(row.attributes) ?? [] }));

  for (const { attrs } of cleaned) {
    for (const { trait_type, value } of attrs) {
      if (!traitCounts.has(trait_type)) traitCounts.set(trait_type, new Map());
      const values = traitCounts.get(trait_type);
      values.set(value, (values.get(value) || 0) + 1);
    }
  }

  const totalTokens = cleaned.length;
  const tokenRarity = cleaned.map(({ tokenId, attrs }) => {
    let score = 0;
    for (const { trait_type, value } of attrs) {
      score += totalTokens / traitCounts.get(trait_type).get(value);
    }
    return { tokenId, rarityScore: Math.round(score * 100) / 100 };
  });
  tokenRarity.sort((a, b) => b.rarityScore - a.rarityScore);

  const traitFrequency = Object.create(null);
  for (const [trait, values] of traitCounts) {
    // null-prototype objects: safe to key by arbitrary strings in output too
    const bucket = Object.create(null);
    for (const [value, count] of values) bucket[value] = count;
    traitFrequency[trait] = bucket;
  }
  return { traitFrequency, tokenRarity, totalTokens };
}
