"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { BACKEND_URL } from "../../../../lib/api";

type Holder = {
  ownerAddress: string;
  tokenCount: number;
  percentage: number;
};

export default function CollectionHoldersPage() {
  const params = useParams();
  const collectionId = params.id as string;

  const [holders, setHolders] = useState<Holder[]>([]);
  const [uniqueHolders, setUniqueHolders] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/collections/${collectionId}/holders`)
      .then((r) => r.json())
      .then((data) => {
        setHolders(data.holders || []);
        setUniqueHolders(data.uniqueHolders || 0);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [collectionId]);

  if (loading) return <p className="muted">Loading...</p>;
  if (holders.length === 0) return <p className="muted">No tokens minted yet — no holders to show.</p>;

  return (
    <div>
      <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "1rem" }}>{uniqueHolders} unique holder{uniqueHolders === 1 ? "" : "s"}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "var(--slate-dim)", border: "1px solid var(--slate-dim)" }}>
        {holders.map((holder) => (
          <div
            key={holder.ownerAddress}
            style={{ background: "var(--ink-raised)", padding: "0.9rem 1.25rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}
          >
            <span className="data" style={{ fontSize: "0.85rem" }}>{holder.ownerAddress.slice(0, 8)}…{holder.ownerAddress.slice(-6)}</span>
            <div style={{ display: "flex", gap: "1.5rem", alignItems: "center" }}>
              <span className="data muted" style={{ fontSize: "0.8rem" }}>{holder.percentage}%</span>
              <span className="data stat-value" style={{ fontSize: "0.95rem" }}>{holder.tokenCount}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}