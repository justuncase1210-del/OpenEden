"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { BACKEND_URL, formatUsdc } from "../../../../lib/api";

type PricePoint = {
  bucket: string;
  avg_price: string;
  sales_count: string;
};

export default function CollectionAnalyticsPage() {
  const params = useParams();
  const collectionId = params.id as string;

  const [history, setHistory] = useState<PricePoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/collections/${collectionId}/price-history?bucket=day`)
      .then((r) => r.json())
      .then((data) => setHistory(data.history || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [collectionId]);

  if (loading) return <p className="muted">Loading...</p>;
  if (history.length === 0) return <p className="muted">No completed sales yet - nothing to chart. Analytics reflects real settled prices, not listing asks.</p>;

  const maxPrice = Math.max(...history.map((h) => parseFloat(h.avg_price)));

  return (
    <div>
      <h2 style={{ fontSize: "1.1rem", marginBottom: "1.5rem" }}>Average sale price, by day</h2>
      <div style={{ display: "flex", alignItems: "flex-end", gap: "0.5rem", height: "200px", borderBottom: "1px solid var(--slate-dim)", paddingBottom: "0.5rem" }}>
        {history.map((point, i) => {
          const heightPct = maxPrice > 0 ? (parseFloat(point.avg_price) / maxPrice) * 100 : 0;
          return (
            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", height: "100%", justifyContent: "flex-end" }}>
              <span className="data muted" style={{ fontSize: "0.65rem", marginBottom: "0.4rem" }}>${formatUsdc(point.avg_price)}</span>
              <div style={{ width: "100%", height: `${heightPct}%`, background: "var(--signal)", minHeight: "2px", borderRadius: "2px 2px 0 0" }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
        {history.map((point, i) => (
          <div key={i} style={{ flex: 1, textAlign: "center" }}>
            <span className="data muted" style={{ fontSize: "0.65rem" }}>{new Date(point.bucket).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
          </div>
        ))}
      </div>

      <p className="muted" style={{ fontSize: "0.78rem", marginTop: "2rem" }}>Every bar is a real average of actual settled sales that day - never estimated or interpolated.</p>
    </div>
  );
}