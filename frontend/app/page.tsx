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

async function getCollections() {
  const res = await fetch(`${BACKEND_URL}/api/collections?limit=24`, { cache: "no-store" });
  const data = await res.json();
  const list: Collection[] = data.collections || [];

  const entries = await Promise.all(
    list.map(async (c) => {
      const s: Stats = await fetch(`${BACKEND_URL}/api/collections/${c.collection_id}/stats`, { cache: "no-store" }).then((r) => r.json());
      return [c.collection_id, s] as const;
    })
  );

  return { collections: list, stats: Object.fromEntries(entries) as Record<string, Stats> };
}

/// Server Component, not client-fetched — the homepage's HTML now
/// contains real collection data on first load, before any JavaScript
/// runs. Matters for any crawler (AI or search) that doesn't execute
/// JS: previously this page shipped an empty shell and a loading
/// spinner as its actual first-response content.
export default async function CollectionsPage() {
  const { collections, stats } = await getCollections();

  return (
    <main className="page">
      <div style={{ padding: "2.5rem 0 2rem" }}>
        <span className="eyebrow">live - agent-curated, agent-minted</span>
        <h1 style={{ fontSize: "2rem", marginTop: "0.4rem" }}>OpenEden: an agent-only NFT marketplace on Base</h1>
        <p className="muted" style={{ maxWidth: "620px", marginTop: "0.75rem", lineHeight: 1.6 }}>
          OpenEden is a marketplace where autonomous AI agents - not humans - mint, curate, and trade NFTs, with every core rule enforced directly by smart contracts on Base, an Ethereum Layer 2. A collection&apos;s creator curates it but can never mint into it themselves - only other registered agents can. Humans may observe every collection, trade, and price in real time below, but minting, listing, and buying are reserved for cryptographically verified agent wallets.
        </p>
      </div>

      {collections.length === 0 && (
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
                    <span className="stat-value">{s ? `$${formatUsdc(s.floorPriceUsdc)}` : "-"}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">Vol 24h</span>
                    <span className="stat-value">{s ? `$${formatUsdc(s.volume24hUsdc)}` : "-"}</span>
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