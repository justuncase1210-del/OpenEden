// Second half of the OpenEden test: everything that reads or extends what the marketplace cycle created.
//   node scripts/test-marketplace-cycle.mjs      (run first)
//   node scripts/test-api-and-tools.mjs
//
// Checks: the indexer picked up every on-chain event with the right data; every public REST route;
// all six paid MCP tools; communities (create / join / leave / metadata / association / posting and the
// 3-posts-a-day cap); the watchlist; link_wallet (positive AND takeover attempts); read-route input validation.
//
// Cost: ~$0.12 of testnet USDC in x402 fees (+ a little gas for the community transactions).
import {
  ABI, setup, logsOf, ensureFunded, tx, expectRevert, usd, fmt, sleep, loadState, connectMcp, payingFetch, signedRequest, getJson, waitFor,
  keccak256, toBytes, ok, bad, warn, info, step, check, die, finish, BACKEND_URL, RUN, IS_LOCAL,
} from "./lib.mjs";

const st = loadState();
const ctx = await setup();
const { curator, minter, buyer, altWallet, altWallet2, stranger } = ctx.actors;
const { addr } = ctx;
const lc = (a) => a.toLowerCase();
const { collectionId, token1, token2 } = st;

console.log("OpenEden API + tools test");
console.log(`  backend: ${BACKEND_URL}   run: ${RUN}   collection #${collectionId}, tokens #${token1} #${token2}`);
if (st.backend !== BACKEND_URL) warn(`saved state is from ${st.backend}, but BACKEND_URL is ${BACKEND_URL}`);

await ensureFunded(ctx, [
  { account: curator, eth: "0.0002", usdc: 0.25 },
  { account: minter, eth: "0.0002", usdc: 0.25 },
  { account: buyer, eth: "0.0002", usdc: 0.40 },
]);

// --------------------------------------------------------------------------------------------- 1
step("1. Wait for the indexer to catch up with the on-chain activity");
const synced = await waitFor("indexer", async () => {
  const n1 = (await getJson(`/api/nfts/${token1}`)).data;
  const n2 = (await getJson(`/api/nfts/${token2}`)).data;
  const offers = (await getJson(`/api/nfts/${token2}/price-history`)).data.history || [];
  return n1.owner_address === lc(buyer.address) && n2.owner_address === lc(buyer.address) && offers.some((h) => h.source === "offer") ? { n1, n2 } : null;
}, { timeoutMs: 120_000 });
if (!synced) die("The indexer did not catch up within 2 minutes. Check the Render logs for '[indexer]' lines.");
ok("indexer is up to date (ownership of both tokens reflects the sale and the accepted offer)");
const { n1, n2 } = synced;

// --------------------------------------------------------------------------------------------- 2
step("2. Indexed data matches what happened on-chain");
check(n1.creator_agent_id === st.agentId.minter && n1.collection_id === collectionId, `token #${token1}: creator agent + collection recorded`, `token1 row: ${JSON.stringify(n1).slice(0, 200)}`);
if (st.usedPinnedMetadata) {
  const gotMeta = await waitFor("metadata", async () => { const r = (await getJson(`/api/nfts/${token1}`)).data; return r.name ? r : null; }, { timeoutMs: 90_000 });
  check(!!gotMeta && /^Cycle Test #1/.test(gotMeta.name), `token #${token1} metadata was fetched from IPFS: "${gotMeta?.name}"`, "metadata (name) never appeared - IPFS gateway slow, or Pinata not pinning");
  check(!!gotMeta?.image_url, `image URL stored: ${gotMeta?.image_url}`, "no image_url stored");
  check(Array.isArray(gotMeta?.attributes) && gotMeta.attributes.length === 3, "3 trait attributes stored", `attributes: ${JSON.stringify(gotMeta?.attributes)}`);
  check(gotMeta?.external_url === "https://example.com/cycle/1" && gotMeta?.animation_url === "https://example.com/cycle/1.mp4" && gotMeta?.background_color === "112233",
    "external_url, animation_url and background_color were pinned, fetched and indexed", `extras: ${gotMeta?.external_url} | ${gotMeta?.animation_url} | ${gotMeta?.background_color}`);
} else warn("cycle used placeholder metadata, so name/image/attribute checks are skipped");

const coll = (await getJson(`/api/collections/${collectionId}`)).data;
check(Number(coll.minted_count) === 2 && coll.mint_ended === true && lc(coll.creator_wallet) === lc(curator.address), "collection row: 2 minted, mint ended, creator = curator", JSON.stringify(coll));
check(Number(coll.mint_price_usdc) === 0.2, "collection mint price $0.20 indexed", `mint_price_usdc = ${coll.mint_price_usdc}`);

const hist = (await getJson(`/api/nfts/${token1}/price-history`)).data.history;
check(hist.length === 1 && hist[0].source === "listing" && Number(hist[0].price) === Number(st.salePrice), `token #${token1} price history shows the $${st.salePrice} sale`, JSON.stringify(hist));
const hist2 = (await getJson(`/api/nfts/${token2}/price-history`)).data.history;
check(hist2.length === 1 && hist2[0].source === "offer" && Number(hist2[0].price) === Number(st.offerAmount), `token #${token2} price history shows the $${st.offerAmount} accepted offer`, JSON.stringify(hist2));

const sold = (await getJson(`/api/marketplace/listings?collectionId=${collectionId}`)).data;
check(sold.total === 0, "no active listings remain (one sold, one cancelled)", `active listings: ${sold.total}`);
const act = (await getJson(`/api/activity?collectionId=${collectionId}&limit=50`)).data.activity;
const types = new Set(act.map((a) => a.event_type));
for (const t of ["minted", "listed", "sold", "cancelled", "offer_made", "offer_accepted"]) check(types.has(t), `activity feed has "${t}"`, `activity feed is missing "${t}" (has: ${[...types].join(", ")})`);
const soldEvent = act.find((a) => a.event_type === "sold");
check(soldEvent && lc(soldEvent.actor_address) === lc(buyer.address), "the 'sold' event names the buyer (buyer_address is recorded)", `sold actor = ${soldEvent?.actor_address}`);
check(act.every((a, i) => i === 0 || new Date(act[i - 1].occurred_at) >= new Date(a.occurred_at) || a.occurred_at === null), "activity is ordered newest-first by BLOCK time", "activity is not ordered by time");

// --------------------------------------------------------------------------------------------- 3
step("3. Public REST routes");
const stats = (await getJson(`/api/collections/${collectionId}/stats`)).data;
check(stats.mintEnded === true && stats.salesCount === 1 && Number(stats.volumeAllTimeUsdc) === Number(st.salePrice) && stats.ownersCount === 1,
  `collection stats: 1 sale, volume $${stats.volumeAllTimeUsdc}, 1 owner (the buyer holds both)`, JSON.stringify(stats));
const holders = (await getJson(`/api/collections/${collectionId}/holders`)).data;
const topHolder = holders.holders?.[0];
check(topHolder && lc(topHolder.ownerAddress) === lc(buyer.address) && topHolder.tokenCount === 2 && topHolder.percentage === 100, "holders: the buyer holds 2/2 tokens (100%)", JSON.stringify(holders).slice(0, 200));
const items = (await getJson(`/api/collections/${collectionId}/items`)).data;
check(items.total === 2 && items.items.length === 2, "items tab lists both tokens", JSON.stringify(items).slice(0, 200));
if (st.usedPinnedMetadata) {
  const traits = (await getJson(`/api/collections/${collectionId}/traits`)).data;
  check(traits.traitFrequency?.Eyes?.Green === 2 && traits.traitFrequency?.Hat?.Crown === 1, "traits: Eyes=Green appears 2x, Hat=Crown 1x", JSON.stringify(traits.traitFrequency));
  check(traits.tokenRarity?.length === 2, "rarity scores computed for both tokens", JSON.stringify(traits).slice(0, 160));
}
check((await getJson(`/api/collections/${collectionId}/offers`)).status === 200, "collection offers route works (no active offers left)", "offers route failed");
check((await getJson(`/api/collections/${collectionId}/price-history`)).data.history?.length >= 1, "collection price history has data", "no collection price history");
const trending = await getJson("/api/collections/trending?window=7d");
check(trending.status === 200 && Array.isArray(trending.data.trending), "trending route works", `trending: HTTP ${trending.status}`);
check((await getJson("/api/collections?mintEnded=true")).data.collections?.some((c) => c.collection_id === collectionId), "collections list filters by mintEnded=true", "collection missing from mintEnded=true list");
const agents = (await getJson("/api/agents?limit=100")).data;
for (const [who, id] of Object.entries(st.agentId)) check(agents.agents?.some((a) => a.agent_id === id), `agent directory lists the ${who} (${id})`, `${who} missing from /api/agents`);
const rep = (await getJson(`/api/agents/${st.agentId.buyer}/reputation`)).data;
check(rep.components?.completedPurchases >= 2, `buyer reputation counts both purchases (score ${rep.score})`, JSON.stringify(rep));
const repMinter = (await getJson(`/api/agents/${st.agentId.minter}/reputation`)).data;
check(repMinter.components?.completedSalesAsSeller >= 1, "minter reputation counts the completed sale", JSON.stringify(repMinter));

step("3b. Bad input is rejected cleanly (400), never a crash");
for (const p of ["/api/collections/abc", "/api/collections/abc/traits", "/api/nfts/abc", "/api/nfts/abc/offers", "/api/marketplace/listings?collectionId=zzz",
  "/api/marketplace/listings?maxPriceUsdc=1;DROP", "/api/activity?tokenId=x"]) {
  const r = await getJson(p);
  check(r.status === 400, `${p} -> 400`, `${p} -> HTTP ${r.status}`);
}
const malformed = await fetch(`${BACKEND_URL}/api/watchlist`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
check(malformed.status === 400 || malformed.status === 401, `malformed JSON -> ${malformed.status}, not a 500`, `malformed JSON -> HTTP ${malformed.status}`);

// --------------------------------------------------------------------------------------------- 3c
step("3c. Collection identity (name, symbol, description, image, banner) - set by the creator, paid");
const curPay = payingFetch(ctx, curator), minPay = payingFetch(ctx, minter);
const profilePath = `/api/collections/${collectionId}/profile`;
const uniqueName = `Cycle Cats ${RUN} ${Date.now().toString(36)}`;

let p = await signedRequest({ account: minter, agentId: st.agentId.minter, method: "POST", path: profilePath, body: { name: "Hijacked" }, fetchFn: minPay });
check(p.status === 403, "only the collection's creator can edit its profile (403 for another agent)", `HTTP ${p.status} ${JSON.stringify(p.data)}`);
p = await signedRequest({ account: curator, agentId: st.agentId.curator, method: "POST", path: profilePath, body: {}, fetchFn: curPay });
check(p.status === 400, "an empty update is rejected (400)", `HTTP ${p.status}`);
for (const [label, body] of [
  ["javascript: image URL", { imageUrl: "javascript:alert(1)" }],
  ["plain-http banner URL", { bannerUrl: "http://insecure.example/b.png" }],
  ["data: image URL", { imageUrl: "data:image/png;base64,AAAA" }],
  ["non-https website", { externalUrl: "ipfs://bafyexample" }],
  ["symbol with punctuation", { symbol: "BAD-SYMBOL!" }],
  ["100+ character name", { name: "x".repeat(101) }],
]) {
  p = await signedRequest({ account: curator, agentId: st.agentId.curator, method: "POST", path: profilePath, body, fetchFn: curPay });
  check(p.status === 400, `${label} is rejected (400)`, `${label} -> HTTP ${p.status} ${JSON.stringify(p.data)}`);
}

p = await signedRequest({ account: curator, agentId: st.agentId.curator, method: "POST", path: profilePath, fetchFn: curPay,
  body: { name: uniqueName, symbol: "ccat", description: "Created by the cycle test", externalUrl: "https://example.com/cats", imageUrl: "https://example.com/cats.png", bannerUrl: "https://example.com/banner.png" } });
check(p.status === 200 && p.data.name === uniqueName && p.data.symbol === "CCAT", `creator set the profile: "${p.data.name}" (${p.data.symbol})`, `HTTP ${p.status} ${JSON.stringify(p.data)}`);

let col2 = (await getJson(`/api/collections/${collectionId}`)).data;
check(col2.name === uniqueName && col2.description === "Created by the cycle test" && col2.banner_url === "https://example.com/banner.png" && col2.external_url === "https://example.com/cats",
  "GET /api/collections/:id returns the identity fields", JSON.stringify(col2).slice(0, 220));
check((await getJson(`/api/nfts/${token1}`)).data.collection_name === uniqueName, `the NFT page data now shows the collection name instead of "#${collectionId}"`, "nft route is missing collection_name");
check((await getJson("/api/collections?limit=50")).data.collections.some((c) => c.name === uniqueName), "the collections directory shows the name", "name missing from /api/collections");
const trend = (await getJson("/api/collections/trending?window=7d")).data.trending || [];
if (trend.some((t) => t.collection_id === collectionId)) check(trend.find((t) => t.collection_id === collectionId).name === uniqueName, "trending includes the name", "trending is missing the name");

p = await signedRequest({ account: curator, agentId: st.agentId.curator, method: "POST", path: profilePath, body: { description: null, bannerUrl: "" }, fetchFn: curPay });
col2 = (await getJson(`/api/collections/${collectionId}`)).data;
check(p.status === 200 && col2.description === null && col2.banner_url === null && col2.name === uniqueName, "null / empty clears optional fields without touching the rest", `HTTP ${p.status} ${JSON.stringify(col2).slice(0, 200)}`);

// name uniqueness needs a second collection (a wallet may create 2 per week; the cycle used 1)
let second;
try {
  const created = await tx(ctx, curator, addr.nft, ABI.nft, "createCollection", [3n]);
  second = logsOf(created, ABI.nft, "CollectionCreated")[0].args.collectionId.toString();
} catch { warn("skipped the name-uniqueness check: could not create a second collection (weekly limit of 2 per wallet - use CYCLE_RUN=n for fresh agents)"); }
if (second) {
  const seen = await waitFor("second collection", async () => (await getJson(`/api/collections/${second}`)).status === 200);
  if (seen) {
    p = await signedRequest({ account: curator, agentId: st.agentId.curator, method: "POST", path: `/api/collections/${second}/profile`, body: { name: uniqueName.toUpperCase() }, fetchFn: curPay });
    check(p.status === 409, "a second collection cannot take the same name, even in different capitals (409)", `HTTP ${p.status} ${JSON.stringify(p.data)}`);
    p = await signedRequest({ account: curator, agentId: st.agentId.curator, method: "POST", path: `/api/collections/${second}/profile`, body: { name: `${uniqueName} II` }, fetchFn: curPay });
    check(p.status === 200, "a different name is fine", `HTTP ${p.status}`);
  } else warn("second collection was not indexed in time; skipped the uniqueness check");
}
p = await signedRequest({ account: curator, agentId: st.agentId.curator, method: "POST", path: "/api/collections/99999999/profile", body: { name: "Nope" }, fetchFn: curPay });
check(p.status === 404, "a collection that doesn't exist -> 404", `HTTP ${p.status}`);

// --------------------------------------------------------------------------------------------- 3d
step("3d. Image upload (only exists when ENABLE_IMAGE_UPLOAD=true on the server)");
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const upload = (buf, contentType, account = minter, agentId = st.agentId.minter, fetchFn = minPay) =>
  signedRequest({ account, agentId, method: "POST", path: "/api/uploads/image", rawBuffer: buf, contentType, fetchFn });

let up = await upload(PNG_1x1, "image/png");
if (up.status === 404) {
  warn("image upload is switched off on this server (by design - agents supply their own image URL or pin to IPFS themselves)");
} else if (up.status === 502 || up.status === 503) {
  warn(`image upload is enabled but pinning failed (HTTP ${up.status}: ${up.data.error}) - the Pinata key probably lacks the pinFileToIPFS permission`);
} else {
  check(up.status === 200 && /^ipfs:\/\//.test(up.data.uri) && up.data.bytes === PNG_1x1.length && up.data.contentType === "image/png", `PNG uploaded and pinned -> ${up.data.uri}`, `HTTP ${up.status} ${JSON.stringify(up.data)}`);
  if (IS_LOCAL && up.data.url) {
    const back = await fetch(up.data.url);
    check(back.status === 200 && Buffer.from(await back.arrayBuffer()).equals(PNG_1x1), "the pinned file is retrievable from the gateway, byte for byte", `gateway returned HTTP ${back.status}`);
  }
  up = await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/svg+xml");
  check(up.status === 415, "SVG is refused (415)", `SVG got HTTP ${up.status}`);
  up = await upload(PNG_1x1, "image/jpeg");
  check(up.status === 415, "a PNG labelled as JPEG is refused (415)", `mislabelled got HTTP ${up.status}`);
  up = await upload(Buffer.from("MZ" + "x".repeat(200)), "image/png");
  check(up.status === 415, "a non-image labelled as PNG is refused (415)", `non-image got HTTP ${up.status}`);
  up = await upload(Buffer.alloc(0), "image/png");
  check(up.status === 415, "an empty upload is refused (415)", `empty got HTTP ${up.status}`);
  const noAuth = await fetch(`${BACKEND_URL}/api/uploads/image`, { method: "POST", headers: { "content-type": "image/png" }, body: PNG_1x1 });
  check(noAuth.status === 401, "an unsigned upload is rejected (401)", `unsigned upload got HTTP ${noAuth.status}`);
  const used = await signedRequest({ account: curator, agentId: st.agentId.curator, method: "POST", path: "/api/uploads/image", rawBuffer: PNG_1x1, contentType: "image/png", fetchFn: curPay });
  if (used.status === 200) {
    const asImage = await signedRequest({ account: curator, agentId: st.agentId.curator, method: "POST", path: profilePath, body: { imageUrl: used.data.uri }, fetchFn: curPay });
    check(asImage.status === 200 && asImage.data.image_url === used.data.uri, "the uploaded ipfs:// URI works as the collection image", `HTTP ${asImage.status} ${JSON.stringify(asImage.data)}`);
  }
}

// --------------------------------------------------------------------------------------------- 4
step("4. Paid MCP tools (x402, ~$0.01 each) - called as the buyer");
const mcp = await connectMcp(ctx, buyer);
const free = await mcp.call("get_contract_info", {});
check(free.data.nftContractAddress?.toLowerCase() === lc(addr.nft) && !free.paid, "get_contract_info is free and returns the contract addresses", JSON.stringify(free.data).slice(0, 160));

const t = (r) => (IS_LOCAL ? true : r.paid);
let r = await mcp.call("get_nft", { tokenId: token1 });
check(!r.isError && lc(r.data.owner_address) === lc(buyer.address) && t(r), `get_nft #${token1}: owner is the buyer${r.paid ? " (paid)" : ""}`, JSON.stringify(r).slice(0, 200));
r = await mcp.call("get_nft", { tokenId: "999999" });
check(r.data.raw === "not found" || r.isError, "get_nft on a token that doesn't exist -> 'not found'", JSON.stringify(r).slice(0, 160));
r = await mcp.call("browse_listings", { limit: 5 });
check(Array.isArray(r.data) && !r.isError, `browse_listings returns a list (${Array.isArray(r.data) ? r.data.length : "?"} active)`, JSON.stringify(r).slice(0, 160));
r = await mcp.call("list_communities", { limit: 5 });
check(Array.isArray(r.data) && !r.isError, "list_communities returns a list", JSON.stringify(r).slice(0, 160));
r = await mcp.call("estimate_floor", { collectionId });
check(r.data.collectionId === collectionId && r.data.floorPriceUsdc === null, "estimate_floor: nothing listed -> null (a real number, never a guess)", JSON.stringify(r.data));
r = await mcp.call("estimate_rarity", { tokenId: token2 });
if (st.usedPinnedMetadata) check(r.data.outOf === 2 && r.data.rank >= 1, `estimate_rarity: token #${token2} ranked ${r.data.rank} of ${r.data.outOf} (score ${r.data.rarityScore})`, JSON.stringify(r.data));
else warn("estimate_rarity skipped (placeholder metadata has no attributes)");
r = await mcp.call("detect_wash_trading", { walletAddress: buyer.address });
check(r.data.walletAddress?.toLowerCase() === lc(buyer.address) && Array.isArray(r.data.flaggedCounterparties), "detect_wash_trading runs on the buyer's trades", JSON.stringify(r.data).slice(0, 160));
await mcp.close();

// --------------------------------------------------------------------------------------------- 5
step("5. link_wallet - adding a second wallet to the curator's agent");
const curMcp = await connectMcp(ctx, curator);
const ts = Date.now();
const regMsg = (w) => `Register as an AI NFT Marketplace agent.\nWallet: ${w.address}\nTimestamp: ${ts}`;
const linkMsg = (agentId, w) => `Authorize linking a new wallet to an OpenEden agent.\nAgent: ${agentId}\nNew wallet: ${w.address}\nTimestamp: ${ts}`;

// attack 1: the BUYER tries to attach their own second wallet to the CURATOR's agentId
let atk = await curMcp.call("link_wallet", {
  agentId: st.agentId.curator, newWalletAddress: altWallet2.address, timestamp: ts,
  signature: await altWallet2.signMessage({ message: regMsg(altWallet2) }),
  ownerSignature: await buyer.signMessage({ message: linkMsg(st.agentId.curator, altWallet2) }),
});
check(atk.isError && /already linked/.test(atk.data.error || ""), "takeover attempt (signed by a wallet NOT linked to the agent) is rejected", JSON.stringify(atk.data));
// attack 2: no valid owner signature at all
atk = await curMcp.call("link_wallet", {
  agentId: st.agentId.curator, newWalletAddress: altWallet2.address, timestamp: ts,
  signature: await altWallet2.signMessage({ message: regMsg(altWallet2) }),
  ownerSignature: "0x" + "00".repeat(65),
});
check(atk.isError, "takeover attempt with a garbage owner signature is rejected", JSON.stringify(atk.data));

// legit: the curator authorises altWallet
const linked = await curMcp.call("link_wallet", {
  agentId: st.agentId.curator, newWalletAddress: altWallet.address, timestamp: ts,
  signature: await altWallet.signMessage({ message: regMsg(altWallet) }),
  ownerSignature: await curator.signMessage({ message: linkMsg(st.agentId.curator, altWallet) }),
});
check(!linked.isError && linked.data.onChainRegistration?.success, "curator authorised a second wallet", JSON.stringify(linked.data));
await curMcp.close();
check(await ctx.pub.readContract({ address: addr.registry, abi: ABI.registry, functionName: "isAgentWallet", args: [altWallet.address] }), "second wallet is allowlisted on-chain", "second wallet is not on-chain allowlisted");
check((await ctx.pub.readContract({ address: addr.registry, abi: ABI.registry, functionName: "agentIdOf", args: [altWallet.address] })) === st.agentId.curator, "on-chain, the second wallet maps to the curator's agentId", "agentIdOf mismatch");
// the linked wallet can now act for the agent over REST
let w = await signedRequest({ account: altWallet, agentId: st.agentId.curator, method: "POST", path: "/api/watchlist", body: { collectionId } });
check(w.status === 200 || w.status === 409, "the linked wallet can sign REST requests as the curator's agent", `HTTP ${w.status} ${JSON.stringify(w.data)}`);
const wl0 = (await getJson(`/api/watchlist?agentId=${st.agentId.curator}`)).data.items || [];
if (wl0.length) { const d = await signedRequest({ account: curator, agentId: st.agentId.curator, method: "DELETE", path: `/api/watchlist/${wl0[0].id}` }); check(d.status === 200, "cleaned up the curator's test watchlist entry", `delete -> ${d.status}`); }
// a wallet that is not linked cannot
w = await signedRequest({ account: altWallet2, agentId: st.agentId.curator, method: "POST", path: "/api/watchlist", body: { collectionId } });
check(w.status === 403, "an unlinked wallet signing as the curator is rejected (403)", `HTTP ${w.status}`);

// --------------------------------------------------------------------------------------------- 6
step("6. Watchlist (wallet-signed)");
const add = await signedRequest({ account: buyer, agentId: st.agentId.buyer, method: "POST", path: "/api/watchlist", body: { tokenId: token1 } });
check(add.status === 200 && add.data.id, `buyer added token #${token1} to their watchlist`, `HTTP ${add.status} ${JSON.stringify(add.data)}`);
const dup = await signedRequest({ account: buyer, agentId: st.agentId.buyer, method: "POST", path: "/api/watchlist", body: { tokenId: token1 } });
check(dup.status === 409, "adding it twice -> 409 already on watchlist", `HTTP ${dup.status}`);
const both = await signedRequest({ account: buyer, agentId: st.agentId.buyer, method: "POST", path: "/api/watchlist", body: { tokenId: token1, collectionId } });
check(both.status === 400, "giving both tokenId and collectionId -> 400", `HTTP ${both.status}`);
const missing = await signedRequest({ account: buyer, agentId: st.agentId.buyer, method: "POST", path: "/api/watchlist", body: { tokenId: 99999999 } });
check(missing.status === 404, "watching a token that doesn't exist -> 404", `HTTP ${missing.status}`);
let list = (await getJson(`/api/watchlist?agentId=${st.agentId.buyer}`)).data.items;
check(list.length === 1 && list[0].token_id === token1, "GET /api/watchlist shows the entry", JSON.stringify(list));
const steal = await signedRequest({ account: minter, agentId: st.agentId.minter, method: "DELETE", path: `/api/watchlist/${add.data.id}` });
check(steal.status === 404, "another agent cannot delete the buyer's watchlist entry (404)", `HTTP ${steal.status}`);
const del = await signedRequest({ account: buyer, agentId: st.agentId.buyer, method: "DELETE", path: `/api/watchlist/${add.data.id}` });
check(del.status === 200, "the owner can delete it", `HTTP ${del.status}`);
list = (await getJson(`/api/watchlist?agentId=${st.agentId.buyer}`)).data.items;
check(list.length === 0, "watchlist is empty again", JSON.stringify(list));

// --------------------------------------------------------------------------------------------- 7
step("7. Communities");
const slug = `oe-test-${RUN}-${Date.now().toString(36)}`;
info(`slug: ${slug}`);
await expectRevert(ctx, "an unregistered wallet cannot create a community", stranger.address, addr.community, ABI.community, "createCommunity", [slug], "NotAgent");
await tx(ctx, curator, addr.community, ABI.community, "createCommunity", [slug]);
ok("curator created the community on-chain");
await expectRevert(ctx, "creating the same slug twice is rejected", minter.address, addr.community, ABI.community, "createCommunity", [slug], "AlreadyExists");
await tx(ctx, minter, addr.community, ABI.community, "join", [slug]);
await expectRevert(ctx, "joining twice is rejected", minter.address, addr.community, ABI.community, "join", [slug], "AlreadyMember");
await tx(ctx, buyer, addr.community, ABI.community, "join", [slug]);
const joined = await waitFor("members", async () => { const c = (await getJson(`/api/community/${slug}`)).data.community; return c && c.member_count === 3 ? c : null; });
check(!!joined, "indexer shows 3 members (curator, minter, buyer)", "member_count never reached 3");
await tx(ctx, buyer, addr.community, ABI.community, "leave", [slug]);
const left = await waitFor("leave", async () => { const c = (await getJson(`/api/community/${slug}`)).data.community; return c && c.member_count === 2 ? c : null; });
check(!!left, "after the buyer leaves, member_count drops to 2 (derived from real membership, not a counter)", "member_count never dropped to 2");
check((await getJson(`/api/community?limit=100`)).data.communities.some((c) => c.slug === slug), "community appears in the public directory", "community missing from /api/community");

const curFetch = payingFetch(ctx, curator), minFetch = payingFetch(ctx, minter), buyFetch = payingFetch(ctx, buyer);
let m = await signedRequest({ account: minter, agentId: st.agentId.minter, method: "POST", path: "/api/community/metadata", body: { slug, name: "Hijacked", description: "x" }, fetchFn: minFetch });
check(m.status === 403, "a non-creator cannot rename the community (403)", `HTTP ${m.status} ${JSON.stringify(m.data)}`);
m = await signedRequest({ account: curator, agentId: st.agentId.curator, method: "POST", path: "/api/community/metadata", body: { slug, name: `Cycle Club ${RUN}`, description: "Created by the cycle test" }, fetchFn: curFetch });
check(m.status === 200, "the creator set the community name + description (paid)", `HTTP ${m.status} ${JSON.stringify(m.data)}`);
const named = (await getJson(`/api/community/${slug}`)).data.community;
check(named?.name === `Cycle Club ${RUN}`, `community is now named "${named?.name}"`, JSON.stringify(named));

// posting requires: on-chain membership AND owning/minting an NFT associated with the community
m = await signedRequest({ account: minter, agentId: st.agentId.minter, method: "POST", path: "/api/community/post", body: { communitySlug: slug, body: "too early" }, fetchFn: minFetch });
check(m.status === 403, "cannot post before an NFT is associated with the community (403)", `HTTP ${m.status} ${JSON.stringify(m.data)}`);
m = await signedRequest({ account: buyer, agentId: st.agentId.buyer, method: "POST", path: `/api/nfts/${token1}/community`, body: { communitySlug: slug }, fetchFn: buyFetch });
check(m.status === 200, `the current owner (buyer) associated token #${token1} with the community`, `HTTP ${m.status} ${JSON.stringify(m.data)}`);
m = await signedRequest({ account: minter, agentId: st.agentId.minter, method: "POST", path: `/api/nfts/${token1}/community`, body: { communitySlug: slug }, fetchFn: minFetch });
check(m.status === 409, "association is one-time and immutable (409 on the second attempt)", `HTTP ${m.status}`);
m = await signedRequest({ account: curator, agentId: st.agentId.curator, method: "POST", path: `/api/nfts/${token2}/community`, body: { communitySlug: slug }, fetchFn: curFetch });
check(m.status === 403, "an agent that neither minted nor owns the token cannot associate it (403)", `HTTP ${m.status}`);
m = await signedRequest({ account: minter, agentId: st.agentId.minter, method: "POST", path: `/api/nfts/${token2}/community`, body: { communitySlug: "no-such-community-xyz" }, fetchFn: minFetch });
check(m.status === 404, "associating with a community that doesn't exist on-chain -> 404", `HTTP ${m.status}`);

const eligible = (await getJson(`/api/community/${slug}/eligible-tokens?agentId=${st.agentId.minter}`)).data.eligibleTokens;
check(Array.isArray(eligible) && eligible.some((e) => e.token_id === token2) && !eligible.some((e) => e.token_id === token1),
  "eligible-tokens lists the not-yet-associated token only", JSON.stringify(eligible));

// the minter minted token #1 (now associated) and is an on-chain member -> may post
let landed = 0, last;
for (let i = 1; i <= 4; i++) {
  last = await signedRequest({ account: minter, agentId: st.agentId.minter, method: "POST", path: "/api/community/post", body: { communitySlug: slug, body: `cycle test post ${i}`, tokenId: token1 }, fetchFn: minFetch });
  if (last.status === 200) landed++;
}
check(landed === 3 && last.status === 429, "3 posts land, the 4th is refused (429) - the daily cap", `landed ${landed}, last status ${last.status} ${JSON.stringify(last.data)}`);
m = await signedRequest({ account: buyer, agentId: st.agentId.buyer, method: "POST", path: "/api/community/post", body: { communitySlug: slug, body: "I left, I shouldn't be able to post" }, fetchFn: buyFetch });
check(m.status === 403, "a wallet that left the community cannot post (403)", `HTTP ${m.status}`);
const thread = (await getJson(`/api/community/${slug}`)).data.posts;
check(thread.length === 3 && thread.every((p) => p.author_agent_id === st.agentId.minter), "the community page shows the 3 posts, all by the minter", JSON.stringify(thread).slice(0, 200));

// --------------------------------------------------------------------------------------------- 8
step("8. Authentication is enforced on every write route");
for (const [method, p, body] of [
  ["POST", "/api/community/post", { communitySlug: slug, body: "spoof", agentId: st.agentId.minter }],
  ["POST", "/api/community/metadata", { slug, name: "spoof", agentId: st.agentId.curator }],
  ["POST", `/api/nfts/${token1}/community`, { communitySlug: slug, agentId: st.agentId.buyer }],
  ["POST", "/api/nfts/prepare-metadata", { name: "x", image: "https://x.example/y.png", agentId: st.agentId.minter }],
  ["POST", "/api/watchlist", { tokenId: token1, agentId: st.agentId.buyer }],
  ["POST", `/api/collections/${collectionId}/profile`, { name: "spoof", agentId: st.agentId.curator }],
  ["DELETE", "/api/watchlist/1?agentId=" + st.agentId.buyer, undefined],
]) {
  const res = await fetch(`${BACKEND_URL}${p}`, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  check(res.status === 401, `${method} ${p.split("?")[0]} with only an agentId -> 401`, `${method} ${p.split("?")[0]} -> HTTP ${res.status} (should be 401)`);
}

finish("API + tools");
