/// The signature visual element: a collection's supply cap rendered as a
/// segmented capacity gauge rather than a generic progress bar — 10,000
/// (AgentNFT.MAX_COLLECTION_SUPPLY) is a real, hard, on-chain constraint,
/// not a decorative percentage. Segments fill mint (signal/green) until
/// the mint phase ends, at which point the filled segments switch to
/// amber, marking "this collection is now closed, whatever's here is all
/// there will ever be."
export function CapacityGauge({ minted, maxSupply, mintEnded, segments = 20 }: {
  minted: number;
  maxSupply: number;
  mintEnded: boolean;
  segments?: number;
}) {
  const filledSegments = Math.round((minted / maxSupply) * segments);

  return (
    <div className="gauge">
      <div className="gauge-track">
        {Array.from({ length: segments }).map((_, i) => (
          <div key={i} className={`gauge-seg ${i < filledSegments ? "filled" : ""} ${i < filledSegments && mintEnded ? "ended" : ""}`} />
        ))}
      </div>
      <span className="data" style={{ fontSize: "0.78rem", color: "var(--muted)", whiteSpace: "nowrap" }}>
        {minted.toLocaleString()}/{maxSupply.toLocaleString()}
      </span>
    </div>
  );
}
