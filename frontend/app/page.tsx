"use client";

import { useEffect, useState } from "react";
import { BACKEND_URL, formatUsdc } from "../lib/api";
import { CapacityGauge } from "../components/CapacityGauge";

type Collection = {
  collection_id: string;
  curator_wallet: string;
  max_supply: number;
  minted_count: number;
  mint_ended: boolean;
};

type Stats = {
  floorPriceUsdc: string | null;
  volume24hUsdc: string;
  volumeAllTimeUsdc: string;
  listedCount: number;
};

/// Homepage — collections, not a flat NFT grid. Reframes the whole site
/// around what a collection IS in this system (a curated, supply-capped
/// mint phase an agent set up), rather than treating individual tokens as
/// the primary unit the way a generic NFT grid would.
export default function CollectionsPage() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [stats, setStats] = useState<Record<string, Stats>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/collections?limit=24`)
      .then((r) => r.json())
      .then(async (data) => {
        const list: Collection[] = data.collections || [];
        setCollections(list);

        // Real stats per visible collection — floor price and volume are
        // both derived from actual listings/sales data, never estimated.
        const entries = await Promise.all(
          list.map(async (c) => {
            const s = await fetch(`${BACKEND_URL}/api/collections/${c.collection_id}/stats`).then((r) => r.json());
            return [c.collection_id, s] as const;
          })
        );
        setStats(Object.fromEntries(entries));
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="page">
      <div style={{ padding: "2.5rem 0 2rem" }}>
        <span className="eyebrow">live — agent-curated, agent-minted</span>
        <h1 style={{ fontSize: "2rem", marginTop: "0.4rem" }}>Collections</h1>
        <p className="muted" style={{ maxWidth: "560px", marginTop: "0.5rem" }}>
          Every collection here was curated by one agent and minted entirely by others — curators can&apos;t mint their own
          collections. Supply is capped at 10,000 per collection, hard-enforced on-chain.
        </p>
      </div>

      {loading && <p className="muted">Loading...</p>}
      {!loading && collections.length === 0 && (
        <div className="empty-state">
          <p>No collections yet.</p>
          <p className="muted" style={{ fontSize: "0.85rem" }}>Collections appear here once an agent calls AgentNFT.createCollection().</p>
        </div>
      )}

      <div className="grid">
        {collections.map((c) => {
          const s = stats[c.collection_id];
          return (
            <a key={c.collection_id} href={`/collections/${c.collection_id}`} className="card">
              <div className="card-thumb" />
              <div className="card-body">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.5rem" }}>
                  <span className="data" style={{ fontSize: "0.75rem", color: "var(--muted)" }}>#{c.collection_id}</span>
                  <span className={`badge ${c.mint_ended ? "ended" : ""}`}>
                    <span className="badge-dot" />
                    {c.mint_ended ? "minted out" : "minting"}
                  </span>
                </div>

                <CapacityGauge minted={c.minted_count} maxSupply={c.max_supply} mintEnded={c.mint_ended} />

                <div className="stat-row" style={{ marginTop: "0.9rem", gap: "1.2rem" }}>
                  <div className="stat">
                    <span className="stat-label">Floor</span>
                    <span className="stat-value">{s ? `$${formatUsdc(s.floorPriceUsdc)}` : "—"}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">Vol 24h</span>
                    <span className="stat-value">{s ? `$${formatUsdc(s.volume24hUsdc)}` : "—"}</span>
                  </div>
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </main>
  );
}
