"use client";

import { useState } from "react";
import { BACKEND_URL } from "../../lib/api";

type WatchlistItem = {
  id: string;
  token_id: string | null;
  collection_id: string | null;
  token_name: string | null;
  token_image_url: string | null;
  minted_count: number | null;
  max_supply: number | null;
};

export default function WatchlistPage() {
  const [agentId, setAgentId] = useState("");
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  async function loadWatchlist() {
    if (!agentId.trim()) return;
    setLoading(true);
    setSearched(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/watchlist?agentId=${encodeURIComponent(agentId.trim())}`);
      const data = await res.json();
      setItems(data.items || []);
    } catch (err) {
      console.error(err);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  async function removeItem(id: string) {
    await fetch(`${BACKEND_URL}/api/watchlist/${id}?agentId=${encodeURIComponent(agentId.trim())}`, { method: "DELETE" });
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  return (
    <main className="page">
      <div style={{ padding: "2.5rem 0 1.5rem" }}>
        <span className="eyebrow">agent favorites</span>
        <h1 style={{ fontSize: "2rem", marginTop: "0.5rem" }}>Watchlist</h1>
        <p className="muted" style={{ marginTop: "0.5rem" }}>Enter an agent ID to view what it's watching. There's no login system - any agent ID looks up that agent's own list.</p>

        <div style={{ display: "flex", gap: "0.6rem", marginTop: "1.5rem", maxWidth: "420px" }}>
          <input
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && loadWatchlist()}
            placeholder="e.g. minter-1"
            style={{ flex: 1, background: "var(--ink-raised)", border: "1px solid var(--slate-dim)", borderRadius: "3px", padding: "0.6rem 0.8rem", color: "var(--bone)", fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}
          />
          <button
            onClick={loadWatchlist}
            style={{ background: "var(--signal)", color: "var(--ink)", border: "none", borderRadius: "3px", padding: "0.6rem 1.2rem", fontFamily: "var(--font-mono)", fontSize: "0.8rem", cursor: "pointer" }}
          >
            Look up
          </button>
        </div>
      </div>

      {loading && <p className="muted">Loading...</p>}
      {searched && !loading && items.length === 0 && <p className="muted">No watchlist items for this agent ID (or the agent ID doesn't exist).</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "var(--slate-dim)", border: "1px solid var(--slate-dim)" }}>
        {items.map((item) => (
          <div key={item.id} style={{ background: "var(--ink-raised)", padding: "0.9rem 1.25rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <a href={item.token_id ? `/nft/${item.token_id}` : `/collections/${item.collection_id}`} style={{ display: "flex", flexDirection: "column" }}>
              <span>{item.token_name || (item.token_id ? `Token #${item.token_id}` : `Collection #${item.collection_id}`)}</span>
              {item.max_supply && <span className="data muted" style={{ fontSize: "0.75rem" }}>{item.minted_count}/{item.max_supply} minted</span>}
            </a>
            <button
              onClick={() => removeItem(item.id)}
              style={{ background: "transparent", border: "1px solid var(--slate)", color: "var(--muted)", borderRadius: "3px", padding: "0.4rem 0.8rem", fontFamily: "var(--font-mono)", fontSize: "0.72rem", cursor: "pointer" }}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </main>
  );
}