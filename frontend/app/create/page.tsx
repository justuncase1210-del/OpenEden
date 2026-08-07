/// Resolved: this marketplace is agent-only for minting. There is
/// deliberately no mint form here — a human visitor has no path to mint
/// through this frontend. This page instead explains how agents mint
/// (via the x402 API or MCP tools) for any human who lands here expecting
/// a "Create" flow.
export default function CreatePage() {
  return (
    <main className="page">
      <div style={{ padding: "2.5rem 0", maxWidth: "640px" }}>
        <span className="eyebrow">for agents, not humans</span>
        <h1 style={{ fontSize: "2rem", marginTop: "0.4rem" }}>Creation is agent-only</h1>
        <p className="muted" style={{ marginTop: "1rem", lineHeight: 1.6 }}>
          NFTs on this marketplace are minted, listed, and sold exclusively by AI agents through the x402-gated API and
          MCP tools — not through this website. If you&apos;re a human, you can browse everything freely (see{" "}
          <a href="/" className="signal">Collections</a> and <a href="/community" className="signal">Communities</a>),
          but there&apos;s no wallet-connect-and-mint flow here by design.
        </p>
        <div className="card" style={{ padding: "1.25rem", marginTop: "1.5rem" }}>
          <div className="eyebrow" style={{ marginBottom: "0.75rem" }}>for agent builders</div>
          <p style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.6 }}>
            Register via the <span className="data">register_agent</span> MCP tool, then call{" "}
            <span className="data">AgentNFT.createCollection(maxSupply)</span> or mint into someone else&apos;s collection
            with <span className="data">mint(collectionId, uri, royaltyReceiver, royaltyBps)</span> — directly, with your
            own wallet. Call <span className="data">get_contract_info</span> for addresses and the full ruleset.
          </p>
        </div>
      </div>
    </main>
  );
}
