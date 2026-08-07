"use client";

import { useEffect, useState } from "react";
import { BACKEND_URL, formatUsdc } from "../../lib/api";

type Listing = {
  listing_id: string;
  token_id: string;
  collection_id: string;
  price_usdc: string;
  name: string;
  image_url: string;
};

const PAGE_SIZE = 24;

export default function ListingsPage() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`${BACKEND_URL}/api/marketplace/listings?limit=${PAGE_SIZE}&offset=${offset}`)
      .then((r) => r.json())
      .then((data) => {
        setListings(data.listings || []);
        setTotal(data.total || 0);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [offset]);

  return (
    <main className="page">
      <div style={{ padding: "2.5rem 0 2rem" }}>
        <span className="eyebrow">marketplace-wide</span>
        <h1 style={{ fontSize: "2rem", marginTop: "0.4rem" }}>Active listings</h1>
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          {total.toLocaleString()} listed across every collection
        </p>
      </div>

      {loading && <p className="muted">Loading...</p>}
      {!loading && listings.length === 0 && <p className="muted">No active listings.</p>}

      <div className="grid">
        {listings.map((l) => (
          <a key={l.listing_id} href={`/nft/${l.token_id}`} className="card">
            <img className="card-thumb" src={l.image_url} alt={l.name} />
            <div className="card-body">
              <div style={{ fontSize: "0.85rem", marginBottom: "0.2rem" }}>{l.name || `Token #${l.token_id}`}</div>
              <a href={`/collections/${l.collection_id}`} className="muted" style={{ fontSize: "0.72rem" }} onClick={(e) => e.stopPropagation()}>
                Collection #{l.collection_id}
              </a>
              <div className="data stat-value" style={{ fontSize: "1rem", marginTop: "0.5rem" }}>${formatUsdc(l.price_usdc)}</div>
            </div>
          </a>
        ))}
      </div>

      {total > PAGE_SIZE && (
        <div style={{ display: "flex", gap: "1rem", justifyContent: "center", padding: "2rem 0" }}>
          <button
            className="mono"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            style={{ background: "none", border: "1px solid var(--slate)", color: "var(--bone)", padding: "0.5rem 1rem", cursor: offset === 0 ? "default" : "pointer", opacity: offset === 0 ? 0.4 : 1 }}
          >
            ← Prev
          </button>
          <span className="muted" style={{ alignSelf: "center", fontSize: "0.85rem" }}>
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <button
            className="mono"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            style={{ background: "none", border: "1px solid var(--slate)", color: "var(--bone)", padding: "0.5rem 1rem", cursor: offset + PAGE_SIZE >= total ? "default" : "pointer", opacity: offset + PAGE_SIZE >= total ? 0.4 : 1 }}
          >
            Next →
          </button>
        </div>
      )}
    </main>
  );
}
