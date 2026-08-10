"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { BACKEND_URL, formatUsdc } from "../../../../lib/api";

type Collection = {
  collection_id: string;
  contract_address: string;
  creator_agent_id: string;
  creator_wallet: string;
  max_supply: number;
  minted_count: number;
  mint_ended: boolean;
  verified: boolean;
  mint_price_usdc: string;
  created_at: string;
};

export default function CollectionAboutPage() {
  const params = useParams();
  const collectionId = params.id as string;

  const [collection, setCollection] = useState<Collection | null>(null);
  const [loading, setLoading] = useState(true);
  const [showVerifyForm, setShowVerifyForm] = useState(false);
  const [secretInput, setSecretInput] = useState("");
  const [verifyMsg, setVerifyMsg] = useState("");

  function load() {
    fetch(`${BACKEND_URL}/api/collections/${collectionId}`)
      .then((r) => r.json())
      .then(setCollection)
      .catch(console.error)
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, [collectionId]);

  async function handleVerify() {
    if (!secretInput) return;
    setVerifyMsg("Working...");
    try {
      const res = await fetch(`${BACKEND_URL}/api/collections/${collectionId}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Secret": secretInput },
        body: JSON.stringify({ verified: true }),
      });
      const data = await res.json();
      if (!res.ok) { setVerifyMsg(`Failed: ${data.error}`); return; }
      setVerifyMsg("Verified!");
      setSecretInput("");
      setShowVerifyForm(false);
      load();
    } catch (err) {
      setVerifyMsg("Request failed.");
    }
  }

  if (loading) return <p className="muted">Loading...</p>;
  if (!collection) return <p className="muted">Collection not found.</p>;

  const mintPrice = parseFloat(collection.mint_price_usdc);

  return (
    <div style={{ maxWidth: "560px" }}>
      {collection.verified && (
        <div className="badge" style={{ marginBottom: "1.5rem" }}><span className="badge-dot" />Verified collection</div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "var(--slate-dim)", border: "1px solid var(--slate-dim)" }}>
        <div style={{ background: "var(--ink-raised)", padding: "0.9rem 1.25rem", display: "flex", justifyContent: "space-between" }}>
          <span className="muted" style={{ fontSize: "0.85rem" }}>Curator</span>
          <span className="data" style={{ fontSize: "0.85rem" }}>{collection.creator_agent_id}</span>
        </div>
        <div style={{ background: "var(--ink-raised)", padding: "0.9rem 1.25rem", display: "flex", justifyContent: "space-between" }}>
          <span className="muted" style={{ fontSize: "0.85rem" }}>Curator wallet</span>
          <span className="data" style={{ fontSize: "0.85rem" }}>{collection.creator_wallet.slice(0, 8)}...{collection.creator_wallet.slice(-6)}</span>
        </div>
        <div style={{ background: "var(--ink-raised)", padding: "0.9rem 1.25rem", display: "flex", justifyContent: "space-between" }}>
          <span className="muted" style={{ fontSize: "0.85rem" }}>Contract address</span>
          <span className="data" style={{ fontSize: "0.85rem" }}>{collection.contract_address.slice(0, 8)}...{collection.contract_address.slice(-6)}</span>
        </div>
        <div style={{ background: "var(--ink-raised)", padding: "0.9rem 1.25rem", display: "flex", justifyContent: "space-between" }}>
          <span className="muted" style={{ fontSize: "0.85rem" }}>Supply cap</span>
          <span className="data" style={{ fontSize: "0.85rem" }}>{collection.max_supply.toLocaleString()}</span>
        </div>
        <div style={{ background: "var(--ink-raised)", padding: "0.9rem 1.25rem", display: "flex", justifyContent: "space-between" }}>
          <span className="muted" style={{ fontSize: "0.85rem" }}>Mint price</span>
          <span className="data" style={{ fontSize: "0.85rem" }}>{mintPrice > 0 ? `$${formatUsdc(collection.mint_price_usdc)} per mint` : "Free"}</span>
        </div>
        <div style={{ background: "var(--ink-raised)", padding: "0.9rem 1.25rem", display: "flex", justifyContent: "space-between" }}>
          <span className="muted" style={{ fontSize: "0.85rem" }}>Mint status</span>
          <span className="data" style={{ fontSize: "0.85rem" }}>{collection.mint_ended ? "Ended" : "Active"}</span>
        </div>
        <div style={{ background: "var(--ink-raised)", padding: "0.9rem 1.25rem", display: "flex", justifyContent: "space-between" }}>
          <span className="muted" style={{ fontSize: "0.85rem" }}>Created</span>
          <span className="data" style={{ fontSize: "0.85rem" }}>{new Date(collection.created_at).toLocaleDateString()}</span>
        </div>
      </div>

      {!collection.verified && !showVerifyForm && (
        <button
          onClick={() => setShowVerifyForm(true)}
          style={{ marginTop: "1.5rem", background: "transparent", border: "1px solid var(--amber)", color: "var(--amber)", borderRadius: "3px", padding: "0.5rem 1rem", fontFamily: "var(--font-mono)", fontSize: "0.78rem", cursor: "pointer" }}
        >
          Admin: verify this collection
        </button>
      )}

      {showVerifyForm && (
        <div style={{ marginTop: "1.5rem", display: "flex", gap: "0.6rem", alignItems: "center" }}>
          <input
            type="password"
            value={secretInput}
            onChange={(e) => setSecretInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleVerify()}
            placeholder="Admin secret"
            autoFocus
            style={{ background: "var(--ink-raised)", border: "1px solid var(--slate-dim)", borderRadius: "3px", padding: "0.5rem 0.7rem", color: "var(--bone)", fontFamily: "var(--font-mono)", fontSize: "0.8rem", flex: 1 }}
          />
          <button
            onClick={handleVerify}
            style={{ background: "var(--amber)", color: "var(--ink)", border: "none", borderRadius: "3px", padding: "0.5rem 1rem", fontFamily: "var(--font-mono)", fontSize: "0.78rem", cursor: "pointer" }}
          >
            Confirm
          </button>
        </div>
      )}
      {verifyMsg && <p className="muted" style={{ fontSize: "0.78rem", marginTop: "0.75rem" }}>{verifyMsg}</p>}

      <p className="muted" style={{ fontSize: "0.78rem", marginTop: "1.5rem" }}>Collections don&apos;t have a description field yet - this is every real field that actually exists, nothing invented.</p>
    </div>
  );
}