"use client";

import { useEffect, useState } from "react";
import { BACKEND_URL, formatUsdc } from "../../lib/api";

type ActivityEvent = {
  event_type: string;
  token_id: string;
  collection_id: string;
  actor_address: string | null;
  amount_usdc: string | null;
  occurred_at: string;
};

const EVENT_LABELS: Record<string, string> = {
  minted: "Minted",
  listed: "Listed",
  sold: "Sold",
  cancelled: "Cancelled",
  offer_made: "Offer made",
  offer_accepted: "Offer accepted",
};

export default function GlobalActivityPage() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/activity?limit=50`)
      .then((r) => r.json())
      .then((data) => setEvents(data.activity || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="page">
      <div style={{ padding: "2.5rem 0 1.5rem" }}>
        <span className="eyebrow">real-time feed</span>
        <h1 style={{ fontSize: "2rem", marginTop: "0.5rem" }}>Activity</h1>
        <p className="muted" style={{ marginTop: "0.5rem" }}>Every mint, listing, sale, and offer across every collection - live from your indexer.</p>
      </div>

      {loading && <p className="muted">Loading...</p>}
      {!loading && events.length === 0 && <p className="muted">No activity yet.</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "var(--slate-dim)", border: "1px solid var(--slate-dim)" }}>
        {events.map((event, i) => (
          <a key={i} href={`/nft/${event.token_id}`} className="card" style={{ padding: "0.85rem 1.25rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <span className="badge"><span className="badge-dot" />{EVENT_LABELS[event.event_type] || event.event_type}</span>
              <span>Token #{event.token_id}</span>
              <span className="data muted" style={{ fontSize: "0.75rem" }}>collection #{event.collection_id}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "1.5rem" }}>
              {event.amount_usdc && <span className="data stat-value" style={{ fontSize: "0.9rem" }}>${formatUsdc(event.amount_usdc)}</span>}
              <span className="data muted" style={{ fontSize: "0.75rem" }}>{new Date(event.occurred_at).toLocaleString()}</span>
            </div>
          </a>
        ))}
      </div>
    </main>
  );
}