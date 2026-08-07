"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { BACKEND_URL } from "../../../../lib/api";

type TraitFrequency = Record<string, Record<string, number>>;
type TokenRarity = { tokenId: string; rarityScore: number };

export default function CollectionTraitsPage() {
  const params = useParams();
  const collectionId = params.id as string;

  const [traitFrequency, setTraitFrequency] = useState<TraitFrequency>({});
  const [tokenRarity, setTokenRarity] = useState<TokenRarity[]>([]);
  const [totalTokens, setTotalTokens] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/collections/${collectionId}/traits`)
      .then((r) => r.json())
      .then((data) => {
        setTraitFrequency(data.traitFrequency || {});
        setTokenRarity(data.tokenRarity || []);
        setTotalTokens(data.totalTokensWithTraits || 0);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [collectionId]);

  if (loading) return <p className="muted">Loading...</p>;

  const traitTypes = Object.keys(traitFrequency);
  if (traitTypes.length === 0) {
    return <p className="muted">No tokens in this collection have stored attributes yet - nothing to show traits or rarity for.</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      <div>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "1rem" }}>Trait frequency ({totalTokens} tokens)</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {traitTypes.map((traitType) => (
            <div key={traitType}>
              <div className="eyebrow" style={{ marginBottom: "0.5rem" }}>{traitType}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "var(--slate-dim)", border: "1px solid var(--slate-dim)" }}>
                {Object.entries(traitFrequency[traitType]).map(([value, count]) => (
                  <div key={value} style={{ background: "var(--ink-raised)", padding: "0.6rem 1rem", display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: "0.85rem" }}>{value}</span>
                    <span className="data muted" style={{ fontSize: "0.8rem" }}>{count} ({Math.round((count / totalTokens) * 100)}%)</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "1rem" }}>Rarity ranking</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "var(--slate-dim)", border: "1px solid var(--slate-dim)" }}>
          {tokenRarity.slice(0, 50).map((entry, i) => (
            <a key={entry.tokenId} href={`/nft/${entry.tokenId}`} className="card" style={{ padding: "0.7rem 1.25rem", display: "flex", justifyContent: "space-between" }}>
              <span className="data muted" style={{ fontSize: "0.78rem" }}>#{i + 1}</span>
              <span>Token #{entry.tokenId}</span>
              <span className="data stat-value" style={{ fontSize: "0.9rem" }}>{entry.rarityScore}</span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}