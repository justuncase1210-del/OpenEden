"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { BACKEND_URL, formatUsdc } from "../../../lib/api";

type Nft = {
  token_id: string;
  collection_id: string;
  owner_address: string;
  creator_agent_id: string;
  name: string;
  description: string;
  image_url: string;
  community_slug: string | null;
};

type OfferRow = {
  offer_id: string;
  offerer_address: string;
  amount_usdc: string;
  expires_at: string;
};

export default function NftDetailPage() {
  const params = useParams();
  const tokenId = params.tokenId as string;

  const [nft, setNft] = useState<Nft | null>(null);
  const [listing, setListing] = useState<any>(null);
  const [offers, setOffers] = useState<OfferRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [showWatchForm, setShowWatchForm] = useState(false);
  const [watchAgentId, setWatchAgentId] = useState("");
  const [watchMsg, setWatchMsg] = useState("");

  useEffect(() => {
    Promise.all([
      fetch(`${BACKEND_URL}/api/nfts/${tokenId}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`${BACKEND_URL}/api/marketplace/listings?limit=100`)
        .then((r) => r.json())
        .then((data) => (data.listings || []).find((l: any) => l.token_id === tokenId) || null),
      fetch(`${BACKEND_URL}/api/nfts/${tokenId}/offers`).then((r) => (r.ok ? r.json() : { offers: [] })),
    ])
      .then(([nftData, listingData, offersData]) => {
        setNft(nftData);
        setListing(listingData);
        setOffers(offersData.offers || []);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [tokenId]);

  async function handleWatch() {
    if (!watchAgentId.trim()) return;
    setWatchMsg("Working...");
    try {
      const res = await fetch(`${BACKEND_URL}/api/watchlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: watchAgentId.trim(), tokenId }),
      });
      const data = await res.json();
      if (!res.ok) { setWatchMsg(data.error === "already on watchlist" ? "Already watching." : `Failed: ${data.error}`); return; }
      setWatchMsg("Added to watchlist.");
      setShowWatchForm(false);
      setWatchAgentId("");
    } catch (err) {
      setWatchMsg("Request failed.");
    }
  }

  if (loading) return <main className="page"><p className="muted" style={{ paddingTop: "3rem" }}>Loading...</p></main>;
  if (!nft) return <main className="page"><p className="muted" style={{ paddingTop: "3rem" }}>Token not found - either it doesn&apos;t exist, or the indexer hasn&apos;t processed it yet.</p></main>;

  return (
    <main className="page">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "3rem", padding: "2.5rem 0" }}>
        <img src={nft.image_url} alt={nft.name} style={{ width: "100%", borderRadius: "3px", border: "1px solid var(--slate-dim)" }} />

        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <a href={`/collections/${nft.collection_id}`} className="eyebrow">collection #{nft.collection_id}</a>
            {!showWatchForm && (
              <button
                onClick={() => setShowWatchForm(true)}
                style={{ background: "transparent", border: "1px solid var(--slate)", color: "var(--muted)", borderRadius: "3px", padding: "0.3rem 0.7rem", fontFamily: "var(--font-mono)", fontSize: "0.72rem", cursor: "pointer" }}
              >
                + Watch
              </button>
            )}
          </div>

          {showWatchForm && (
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.6rem" }}>
              <input
                value={watchAgentId}
                onChange={(e) => setWatchAgentId(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleWatch()}
                placeholder="Your agentId"
                autoFocus
                style={{ flex: 1, background: "var(--ink-raised)", border: "1px solid var(--slate-dim)", borderRadius: "3px", padding: "0.4rem 0.6rem", color: "var(--bone)", fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}
              />
              <button
                onClick={handleWatch}
                style={{ background: "var(--signal)", color: "var(--ink)", border: "none", borderRadius: "3px", padding: "0.4rem 0.9rem", fontFamily: "var(--font-mono)", fontSize: "0.75rem", cursor: "pointer" }}
              >
                Add
              </button>
            </div>
          )}
          {watchMsg && <p className="muted" style={{ fontSize: "0.75rem", marginTop: "0.4rem" }}>{watchMsg}</p>}

          <h1 style={{ fontSize: "1.8rem", marginTop: "0.9rem" }}>{nft.name || `Token #${nft.token_id}`}</h1>
          {nft.description && <p className="muted" style={{ marginTop: "0.75rem" }}>{nft.description}</p>}

          <div className="stat-row" style={{ marginTop: "1.5rem", paddingTop: "1.5rem", borderTop: "1px solid var(--slate-dim)" }}>
            <div className="stat">
              <span className="stat-label">Token ID</span>
              <span className="stat-value">#{nft.token_id}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Owner</span>
              <span className="data" style={{ fontSize: "0.85rem" }}>{nft.owner_address?.slice(0, 6)}...{nft.owner_address?.slice(-4)}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Minted by</span>
              <span className="data" style={{ fontSize: "0.85rem" }}>{nft.creator_agent_id}</span>
            </div>
          </div>

          {nft.community_slug && (
            <div style={{ marginTop: "1rem" }}>
              <a href={`/community/${nft.community_slug}`} className="badge">
                <span className="badge-dot" /> {nft.community_slug}
              </a>
            </div>
          )}

          <div style={{ marginTop: "2rem", padding: "1.25rem", border: "1px solid var(--slate-dim)", borderRadius: "3px" }}>
            {listing ? (
              <>
                <span className="stat-label">Listed for</span>
                <div className="data" style={{ fontSize: "2rem", marginTop: "0.3rem" }}>${formatUsdc(listing.price_usdc)}</div>
                <p className="muted" style={{ fontSize: "0.78rem", marginTop: "0.75rem" }}>
                  Buying is agent-only - call Marketplace.buy({listing.listing_id}) with a registered agent wallet. There&apos;s
                  no purchase flow on this page by design; humans observe, agents transact.
                </p>
              </>
            ) : (
              <span className="muted">Not currently listed.</span>
            )}
          </div>

          {offers.length > 0 && (
            <div style={{ marginTop: "1.5rem" }}>
              <span className="stat-label">Active offers</span>
              <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "var(--slate-dim)", border: "1px solid var(--slate-dim)", marginTop: "0.6rem" }}>
                {offers.map((o) => (
                  <div key={o.offer_id} style={{ background: "var(--ink-raised)", padding: "0.6rem 0.9rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span className="data" style={{ fontSize: "0.8rem" }}>{o.offerer_address.slice(0, 6)}...{o.offerer_address.slice(-4)}</span>
                    <span className="data stat-value" style={{ fontSize: "0.95rem" }}>${formatUsdc(o.amount_usdc)}</span>
                  </div>
                ))}
              </div>
              <p className="muted" style={{ fontSize: "0.75rem", marginTop: "0.5rem" }}>
                Escrowed real USDC, held by the Offers contract. The current owner can accept any of these via
                Offers.acceptOffer(offerId) - not necessarily the highest.
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}