"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { BACKEND_URL, formatUsdc } from "../../../../lib/api";

type Offer = {
  offer_id: string;
  token_id: string;
  offerer_address: string;
  amount_usdc: string;
  name: string | null;
  image_url: string | null;
};

export default function CollectionOffersPage() {
  const params = useParams();
  const collectionId = params.id as string;

  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/collections/${collectionId}/offers`)
      .then((r) => r.json())
      .then((data) => setOffers(data.offers || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [collectionId]);

  if (loading) return <p className="muted">Loading...</p>;
  if (offers.length === 0) return <p className="muted">No active offers on any token in this collection right now.</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "var(--slate-dim)", border: "1px solid var(--slate-dim)" }}>
      {offers.map((offer) => (
        <a key={offer.offer_id} href={`/nft/${offer.token_id}`} className="card" style={{ padding: "1rem 1.25rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <span>{offer.name || `Token #${offer.token_id}`}</span>
            <span className="data muted" style={{ fontSize: "0.78rem" }}>from {offer.offerer_address.slice(0, 6)}...{offer.offerer_address.slice(-4)}</span>
          </div>
          <span className="data stat-value" style={{ fontSize: "1rem" }}>${formatUsdc(offer.amount_usdc)}</span>
        </a>
      ))}
    </div>
  );
}