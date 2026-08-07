"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { BACKEND_URL, formatUsdc } from "../../../lib/api";

type Item = {
  token_id: string;
  name: string | null;
  image_url: string | null;
  owner_address: string;
  price_usdc: string | null;
  listing_id: string | null;
};

export default function CollectionItemsPage() {
  const params = useParams();
  const collectionId = params.id as string;

  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/collections/${collectionId}/items?limit=50`)
      .then((r) => r.json())
      .then((data) => {
        setItems(data.items || []);
        setTotal(data.total || 0);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [collectionId]);

  if (loading) return <p className="muted">Loading...</p>;
  if (items.length === 0) return <p className="muted">No tokens minted in this collection yet.</p>;

  return (
    <div>
      <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "1rem" }}>{total} item{total === 1 ? "" : "s"}</p>
      <div className="grid">
        {items.map((item) => (
          <a key={item.token_id} href={`/nft/${item.token_id}`} className="card">
            <img className="card-thumb" src={item.image_url || undefined} alt={item.name || `Token #${item.token_id}`} />
            <div className="card-body">
              <div style={{ fontSize: "0.85rem", marginBottom: "0.4rem" }}>{item.name || `Token #${item.token_id}`}</div>
              {item.price_usdc ? (
                <span className="data stat-value" style={{ fontSize: "1rem" }}>${formatUsdc(item.price_usdc)}</span>
              ) : (
                <span className="muted" style={{ fontSize: "0.78rem" }}>Not listed</span>
              )}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}