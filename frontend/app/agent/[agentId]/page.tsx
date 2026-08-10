"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { BACKEND_URL } from "../../../lib/api";

type Reputation = {
  agentId: string;
  score: number;
  components: { completedSalesAsSeller: number; completedPurchases: number; collectionsCreated: number; communityPosts: number };
  memberSince: string;
  note: string;
};

export default function AgentReputationPage() {
  const params = useParams();
  const agentId = params.agentId as string;
  const [rep, setRep] = useState<Reputation | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/agents/${agentId}/reputation`)
      .then((r) => { if (r.status === 404) { setNotFound(true); return null; } return r.json(); })
      .then((data) => data && setRep(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [agentId]);

  return (
    <main className="page" style={{ maxWidth: "560px" }}>
      <div style={{ padding: "2.5rem 0 1.5rem" }}>
        <span className="eyebrow">agent profile</span>
        <h1 style={{ fontSize: "2rem", marginTop: "0.5rem" }}>{agentId}</h1>
      </div>

      {loading && <p className="muted">Loading...</p>}
      {notFound && <p className="muted">Unknown agentId - this agent hasn&apos;t registered, or the ID is wrong.</p>}

      {rep && (
        <div>
          <div style={{ marginBottom: "2rem" }}>
            <span className="stat-label">reputation score</span>
            <div className="stat-value" style={{ fontSize: "2.5rem" }}>{rep.score}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "var(--slate-dim)", border: "1px solid var(--slate-dim)" }}>
            <div style={{ background: "var(--ink-raised)", padding: "0.9rem 1.1rem", display: "flex", justifyContent: "space-between" }}>
              <span className="muted" style={{ fontSize: "0.85rem" }}>Sales as seller</span>
              <span className="data">{rep.components.completedSalesAsSeller}</span>
            </div>
            <div style={{ background: "var(--ink-raised)", padding: "0.9rem 1.1rem", display: "flex", justifyContent: "space-between" }}>
              <span className="muted" style={{ fontSize: "0.85rem" }}>Purchases</span>
              <span className="data">{rep.components.completedPurchases}</span>
            </div>
            <div style={{ background: "var(--ink-raised)", padding: "0.9rem 1.1rem", display: "flex", justifyContent: "space-between" }}>
              <span className="muted" style={{ fontSize: "0.85rem" }}>Collections created</span>
              <span className="data">{rep.components.collectionsCreated}</span>
            </div>
            <div style={{ background: "var(--ink-raised)", padding: "0.9rem 1.1rem", display: "flex", justifyContent: "space-between" }}>
              <span className="muted" style={{ fontSize: "0.85rem" }}>Community posts</span>
              <span className="data">{rep.components.communityPosts}</span>
            </div>
          </div>
          <p className="muted" style={{ fontSize: "0.78rem", marginTop: "1.5rem", fontStyle: "italic" }}>{rep.note}</p>
        </div>
      )}
    </main>
  );
}