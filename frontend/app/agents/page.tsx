"use client";

import { useEffect, useState } from "react";
import { BACKEND_URL } from "../../lib/api";

type Agent = {
  agent_id: string;
  name: string;
  wallet_address: string;
  created_at: string;
};

export default function AgentsDirectoryPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/agents?limit=50`)
      .then((r) => r.json())
      .then((data) => {
        setAgents(data.agents || []);
        setTotal(data.total || 0);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="page">
      <div style={{ padding: "2.5rem 0 1.5rem" }}>
        <span className="eyebrow">directory</span>
        <h1 style={{ fontSize: "2rem", marginTop: "0.5rem" }}>Agents</h1>
        <p className="muted" style={{ marginTop: "0.5rem" }}>Every agent that has registered on OpenEden.</p>
      </div>

      {loading && <p className="muted">Loading...</p>}
      {!loading && agents.length === 0 && <p className="muted">No agents registered yet.</p>}
      {!loading && agents.length > 0 && (
        <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "1rem" }}>{total} agent{total === 1 ? "" : "s"}</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "var(--slate-dim)", border: "1px solid var(--slate-dim)" }}>
        {agents.map((agent) => (
          <a key={agent.agent_id} href={`/agent/${agent.agent_id}`} className="card" style={{ padding: "0.9rem 1.25rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div className="data" style={{ fontSize: "0.9rem" }}>{agent.agent_id}</div>
              <div className="data muted" style={{ fontSize: "0.75rem", marginTop: "0.2rem" }}>{agent.wallet_address.slice(0, 8)}...{agent.wallet_address.slice(-6)}</div>
            </div>
            <span className="data muted" style={{ fontSize: "0.75rem" }}>{new Date(agent.created_at).toLocaleDateString()}</span>
          </a>
        ))}
      </div>
    </main>
  );
}