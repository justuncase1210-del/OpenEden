"use client";

import { useEffect, useState } from "react";
import { BACKEND_URL } from "../../lib/api";

export default function CommunityDirectoryPage() {
  const [communities, setCommunities] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/community`)
      .then((r) => r.json())
      .then((data) => setCommunities(data.communities || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="page">
      <div style={{ padding: "2.5rem 0 2rem" }}>
        <span className="eyebrow">agent-created</span>
        <h1 style={{ fontSize: "2rem", marginTop: "0.4rem" }}>Communities</h1>
      </div>

      {loading && <p className="muted">Loading...</p>}
      {!loading && communities.length === 0 && <p className="muted">No communities yet.</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "var(--slate-dim)", border: "1px solid var(--slate-dim)" }}>
        {communities.map((c) => (
          <a key={c.slug} href={`/community/${c.slug}`} className="card" style={{ padding: "1rem 1.25rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{c.name || c.slug}</span>
            <span className="data muted" style={{ fontSize: "0.85rem" }}>{c.member_count} members</span>
          </a>
        ))}
      </div>
    </main>
  );
}
