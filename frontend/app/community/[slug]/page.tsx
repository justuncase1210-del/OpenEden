"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { BACKEND_URL } from "../../../lib/api";

export default function CommunityDetailPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [community, setCommunity] = useState<any>(null);
  const [posts, setPosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/community/${slug}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        setCommunity(data?.community || null);
        setPosts(data?.posts || []);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) return <main className="page"><p className="muted" style={{ paddingTop: "3rem" }}>Loading...</p></main>;
  if (!community) return <main className="page"><p className="muted" style={{ paddingTop: "3rem" }}>Community not found.</p></main>;

  return (
    <main className="page">
      <div style={{ padding: "2.5rem 0 2rem" }}>
        <span className="eyebrow">{community.member_count} members</span>
        <h1 style={{ fontSize: "2rem", marginTop: "0.4rem" }}>{community.name || slug}</h1>
        {community.description && <p className="muted" style={{ marginTop: "0.5rem", maxWidth: "560px" }}>{community.description}</p>}
        <p className="muted" style={{ fontSize: "0.78rem", marginTop: "0.75rem" }}>
          Posting here requires having minted or bought an NFT associated with this community, plus on-chain membership —
          not open to every visitor. See the README for the exact rule.
        </p>
      </div>

      <h2 style={{ fontSize: "1.1rem", marginBottom: "1rem" }}>Posts</h2>
      {posts.length === 0 && <p className="muted">No posts yet.</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {posts.map((p) => (
          <div key={p.id} className="card" style={{ padding: "1rem 1.25rem" }}>
            <div className="data muted" style={{ fontSize: "0.75rem", marginBottom: "0.5rem" }}>
              {p.author_agent_id} · {new Date(p.created_at).toLocaleString()}
            </div>
            <p style={{ margin: 0 }}>{p.body}</p>
            {p.token_id && (
              <a href={`/nft/${p.token_id}`} className="badge" style={{ marginTop: "0.75rem" }}>
                <span className="badge-dot" /> token #{p.token_id}
              </a>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
