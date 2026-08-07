"use client";

import { useEffect, useState } from "react";
import { usePathname, useParams } from "next/navigation";
import { BACKEND_URL, formatUsdc } from "../../../lib/api";
import { CapacityGauge } from "../../../components/CapacityGauge";

type Stats = {
  collectionId: string;
  maxSupply: number;
  mintedCount: number;
  mintEnded: boolean;
  floorPriceUsdc: string | null;
  topOfferUsdc: string | null;
  volumeAllTimeUsdc: string;
  volume24hUsdc: string;
  salesCount: number;
  ownersCount: number;
  listedCount: number;
};

const TABS = [
  { href: "", label: "Items" },
  { href: "/offers", label: "Offers" },
  { href: "/holders", label: "Holders" },
  { href: "/traits", label: "Traits" },
  { href: "/activity", label: "Activity" },
  { href: "/analytics", label: "Analytics" },
  { href: "/about", label: "About" },
];

export default function CollectionLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const pathname = usePathname();
  const collectionId = params.id as string;

  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/collections/${collectionId}/stats`)
      .then((r) => r.json())
      .then(setStats)
      .catch(console.error);
  }, [collectionId]);

  const basePath = `/collections/${collectionId}`;

  return (
    <main className="page">
      <div style={{ padding: "2.5rem 0 1.5rem" }}>
        <span className="eyebrow">collection #{collectionId}</span>
        <h1 style={{ fontSize: "2rem", marginTop: "0.4rem" }}>
          {stats ? (stats.mintEnded ? "Mint concluded" : "Minting now") : "Loading..."}
        </h1>

        {stats && (
          <div style={{ marginTop: "1rem", maxWidth: "420px" }}>
            <CapacityGauge minted={stats.mintedCount} maxSupply={stats.maxSupply} mintEnded={stats.mintEnded} segments={30} />
          </div>
        )}
      </div>

      {stats && (
        <div className="stat-row" style={{ padding: "1.5rem 0", borderTop: "1px solid var(--slate-dim)" }}>
          <div className="stat">
            <span className="stat-label">Floor</span>
            <span className="stat-value">{stats.floorPriceUsdc ? `$${formatUsdc(stats.floorPriceUsdc)}` : "-"}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Top offer</span>
            <span className="stat-value">{stats.topOfferUsdc ? `$${formatUsdc(stats.topOfferUsdc)}` : "-"}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Vol 24h</span>
            <span className="stat-value">${formatUsdc(stats.volume24hUsdc)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Owners</span>
            <span className="stat-value">{stats.ownersCount}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Listed</span>
            <span className="stat-value">{stats.listedCount}</span>
          </div>
        </div>
      )}

      <nav style={{ display: "flex", gap: "0.25rem", borderBottom: "1px solid var(--slate-dim)", marginBottom: "2rem" }}>
        {TABS.map((tab) => {
          const href = basePath + tab.href;
          const isActive = tab.href === "" ? pathname === basePath : pathname === href;
          return (
            <a key={tab.href} href={href} style={{ padding: "0.75rem 1rem", fontSize: "0.85rem", color: isActive ? "var(--bone)" : "var(--muted)", borderBottom: isActive ? "2px solid var(--signal)" : "2px solid transparent", marginBottom: "-1px" }}>
              {tab.label}
            </a>
          );
        })}
      </nav>

      {children}
    </main>
  );
}