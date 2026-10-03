// Full marketplace cycle on a LIVE OpenEden deployment, using 3 throwaway agents:
//   curator  - creates the collection and sets a mint price
//   minter   - mints two NFTs into it (pays the mint price, sets a 5% royalty), then lists / sells them
//   buyer    - buys one NFT, and makes / cancels / has accepted offers on the other
//
//   cd backend
//   $env:TEST_FUNDER_PRIVATE_KEY="0x..."     # throwaway wallet with ~0.002 Base Sepolia ETH and ~$5 testnet USDC
//   node scripts/test-marketplace-cycle.mjs
//   node scripts/test-api-and-tools.mjs      # second half: indexer, REST, MCP tools, communities, watchlist
//
// It exercises: agent registration (paid), prepare-metadata (paid, pins to IPFS), createCollection,
// setMintPrice, paid mint with royalty, endMint, list, cancelListing, buy, makeOffer, cancelOffer,
// acceptOffer - and checks every USDC payout (seller / royalty receiver / platform fee) to the unit,
// plus ~20 "this must be rejected" cases (simulated, so they cost nothing).
//
// Cost: ~$0.30 of testnet USDC in fees/tools + ~0.001 ETH gas; the rest just moves between the test wallets.
import {
  ABI, setup, ensureFunded, ensureRegistered, tx, expectRevert, usdcBalance, usd, fmt, sleep, logsOf,
  signedRequest, payingFetch, saveState, ok, bad, warn, info, step, check, die, finish, BACKEND_URL, RUN,
} from "./lib.mjs";

const IMAGE_URL = process.env.TEST_IMAGE_URL || "https://picsum.photos/seed/openeden-cycle/600/600";
const FALLBACK_URI = "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy"; // valid CID, not NFT metadata

const ctx = await setup();
const { curator, minter, buyer, royalty, stranger } = ctx.actors;
const { addr } = ctx;

console.log("OpenEden marketplace cycle test");
console.log(`  backend: ${BACKEND_URL}   run: ${RUN}`);
for (const [k, a] of Object.entries({ funder: ctx.funder, curator, minter, buyer })) console.log(`  ${k.padEnd(8)} ${a.address}`);

// --------------------------------------------------------------------------------------------- 0
step("0. Fund the test wallets (only tops up what's missing)");
await ensureFunded(ctx, [
  { account: curator, eth: "0.0002", usdc: 0.30 },
  { account: minter, eth: "0.0003", usdc: 1.00 },
  { account: buyer, eth: "0.0003", usdc: 2.50 },
]);
ok("curator, minter and buyer funded");

const feeBps = BigInt(await ctx.pub.readContract({ address: addr.market, abi: ABI.market, functionName: "feeBps" }));
const feeRecipient = await ctx.pub.readContract({ address: addr.market, abi: ABI.market, functionName: "feeRecipient" });
const feeRecipientIsActor = [curator, minter, buyer, royalty].some((a) => a.address.toLowerCase() === feeRecipient.toLowerCase());
info(`platform fee ${Number(feeBps) / 100}% -> ${feeRecipient}`);
const cut = (amount, bps) => (amount * bps) / 10_000n;

// --------------------------------------------------------------------------------------------- 1
step("1. Register the three agents (x402 fee, skipped if already registered)");
const agentId = {
  curator: await ensureRegistered(ctx, curator, `cycle-curator-${RUN}`),
  minter: await ensureRegistered(ctx, minter, `cycle-minter-${RUN}`),
  buyer: await ensureRegistered(ctx, buyer, `cycle-buyer-${RUN}`),
};
for (const [who, id] of Object.entries(agentId)) check(!!id, `${who} is an agent (${id})`, `${who} has no agentId`);

step("1b. Rejections for a wallet that never registered");
await expectRevert(ctx, "unregistered wallet cannot create a collection", stranger.address, addr.nft, ABI.nft, "createCollection", [5n], "NotAgent");
await expectRevert(ctx, "unregistered wallet cannot list", stranger.address, addr.market, ABI.market, "list", [1n, usd(1)], "NotAgent");
await expectRevert(ctx, "unregistered wallet cannot make an offer", stranger.address, addr.offers, ABI.offers, "makeOffer", [1n, usd(1), 86400n], "NotAgent");

// --------------------------------------------------------------------------------------------- 2
step("2. Curator creates a collection and sets a mint price");
await expectRevert(ctx, "supply of 0 is rejected", curator.address, addr.nft, ABI.nft, "createCollection", [0n], "CollectionSupplyZero");
await expectRevert(ctx, "supply above 10,000 is rejected", curator.address, addr.nft, ABI.nft, "createCollection", [10_001n], "CollectionSupplyTooHigh");

let collectionId;
try {
  const r = await tx(ctx, curator, addr.nft, ABI.nft, "createCollection", [5n]);
  collectionId = logsOf(r, ABI.nft, "CollectionCreated")[0].args.collectionId;
} catch (err) {
  die(`createCollection failed: ${err.shortMessage || err.message}\n  (A wallet may only create 2 collections per week. Re-run with  $env:CYCLE_RUN="${Number(RUN) + 1}"  to use fresh test agents.)`);
}
ok(`collection #${collectionId} created (max supply 5)`);

const MINT_PRICE = usd(0.20);
await expectRevert(ctx, "a non-creator cannot set the mint price", minter.address, addr.nft, ABI.nft, "setMintPrice", [collectionId, MINT_PRICE], "NotCollectionCreator");
await tx(ctx, curator, addr.nft, ABI.nft, "setMintPrice", [collectionId, MINT_PRICE]);
const col = await ctx.pub.readContract({ address: addr.nft, abi: ABI.nft, functionName: "collections", args: [collectionId] });
check(col[0].toLowerCase() === curator.address.toLowerCase() && col[3] === 5n && col[5] === MINT_PRICE,
  `on-chain: creator = curator, supply 5, mint price $${fmt(col[5])}`, `collection record wrong: ${JSON.stringify(col, (k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
check(col[2] === agentId.curator, "collection records the curator's agentId", `creatorAgentId ${col[2]} != ${agentId.curator}`);

// --------------------------------------------------------------------------------------------- 3
step("3. Minter pins metadata to IPFS (paid, wallet-signed REST call)");
const metas = [
  { name: `Cycle Test #1 (run ${RUN})`, description: "First NFT minted by the cycle test", image: IMAGE_URL,
    external_url: "https://example.com/cycle/1", animation_url: "https://example.com/cycle/1.mp4", background_color: "#112233",
    attributes: [{ trait_type: "Background", value: "Blue" }, { trait_type: "Eyes", value: "Green" }, { trait_type: "Hat", value: "None" }] },
  { name: `Cycle Test #2 (run ${RUN})`, description: "Second NFT minted by the cycle test", image: IMAGE_URL,
    attributes: [{ trait_type: "Background", value: "Red" }, { trait_type: "Eyes", value: "Green" }, { trait_type: "Hat", value: "Crown" }] },
];
const paidFetch = payingFetch(ctx, minter);

for (const [label, extra] of [["external_url that is not https", { external_url: "http://insecure.example" }], ["animation_url with a javascript: scheme", { animation_url: "javascript:alert(1)" }], ["background_color that is not hex", { background_color: "red" }]]) {
  const r = await signedRequest({ account: minter, agentId: agentId.minter, method: "POST", path: "/api/nfts/prepare-metadata", body: { name: "x", image: IMAGE_URL, ...extra }, fetchFn: paidFetch });
  if (r.status === 503) warn(`skipped "${label}" check: server has no PINATA_JWT`);
  else check(r.status === 400, `metadata with ${label} is rejected (400)`, `${label} got HTTP ${r.status} ${JSON.stringify(r.data)}`);
}

const bogus = await signedRequest({ account: minter, agentId: agentId.minter, method: "POST", path: "/api/nfts/prepare-metadata",
  body: { name: "x", image: "http://insecure.example/x.png" }, fetchFn: paidFetch });
if (bogus.status === 503) warn("server has no PINATA_JWT, so metadata can't be pinned (set PINATA_JWT on Render to enable real NFT metadata)");
else check(bogus.status === 400, "metadata with a non-https/ipfs image URL is rejected (400)", `bad-image request got HTTP ${bogus.status} ${JSON.stringify(bogus.data)}`);

const uris = [];
for (const meta of metas) {
  const r = await signedRequest({ account: minter, agentId: agentId.minter, method: "POST", path: "/api/nfts/prepare-metadata", body: meta, fetchFn: paidFetch });
  if (r.status === 200 && /^ipfs:\/\//.test(r.data.tokenUri)) { uris.push(r.data.tokenUri); ok(`pinned "${meta.name}" -> ${r.data.tokenUri}`); }
  else {
    warn(`prepare-metadata returned HTTP ${r.status} ${JSON.stringify(r.data)} - using a placeholder URI (NFT will have no name/image in the index)`);
    uris.push(FALLBACK_URI);
  }
}

// --------------------------------------------------------------------------------------------- 4
step("4. Minter mints two NFTs into the curator's collection (paid mint, 5% royalty)");
const ROYALTY_BPS = 500n;
await expectRevert(ctx, "the curator cannot mint into their own collection", curator.address, addr.nft, ABI.nft, "mint", [collectionId, uris[0], royalty.address, ROYALTY_BPS, MINT_PRICE], "CannotMintOwnCollection");
await expectRevert(ctx, "royalty above 10% is rejected", minter.address, addr.nft, ABI.nft, "mint", [collectionId, uris[0], royalty.address, 1001n, MINT_PRICE], "RoyaltyTooHigh");
await expectRevert(ctx, "mint is rejected when the price exceeds the buyer's max (front-run protection)", minter.address, addr.nft, ABI.nft, "mint", [collectionId, uris[0], royalty.address, ROYALTY_BPS, usd(0.10)], "PriceExceedsMax");

const curatorBefore = await usdcBalance(ctx, curator.address);
const feeBefore = await usdcBalance(ctx, feeRecipient);
await tx(ctx, minter, addr.usdc, ABI.usdc, "approve", [addr.nft, MINT_PRICE * 2n]);

const tokenIds = [];
for (let i = 0; i < 2; i++) {
  if (i > 0) { info("waiting 12s for the per-wallet mint cooldown..."); await sleep(12_000); }
  const r = await tx(ctx, minter, addr.nft, ABI.nft, "mint", [collectionId, uris[i], royalty.address, ROYALTY_BPS, MINT_PRICE]);
  const ev = logsOf(r, ABI.nft, "Minted")[0].args;
  tokenIds.push(ev.tokenId);
  check(ev.agentId === agentId.minter && ev.to.toLowerCase() === minter.address.toLowerCase(), `token #${ev.tokenId} minted to the minter, creator agent recorded`, "Minted event has wrong owner/agent");
}
const mintFee = cut(MINT_PRICE, feeBps);
const curatorGain = (await usdcBalance(ctx, curator.address)) - curatorBefore;
check(curatorGain === (MINT_PRICE - mintFee) * 2n, `curator received the mint price minus the ${Number(feeBps) / 100}% fee ($${fmt(curatorGain)})`, `curator gained $${fmt(curatorGain)}, expected $${fmt((MINT_PRICE - mintFee) * 2n)}`);
if (!feeRecipientIsActor) check((await usdcBalance(ctx, feeRecipient)) - feeBefore === mintFee * 2n, "platform fee on mints reached the fee recipient", "platform mint fee wrong");
const [token1, token2] = tokenIds;
const ri = await ctx.pub.readContract({ address: addr.nft, abi: ABI.nft, functionName: "royaltyInfo", args: [token1, usd(1)] });
check(ri[0].toLowerCase() === royalty.address.toLowerCase() && ri[1] === usd(0.05), "ERC-2981 royalty is 5% to the chosen receiver", `royaltyInfo = ${ri}`);
check((await ctx.pub.readContract({ address: addr.nft, abi: ABI.nft, functionName: "tokenURI", args: [token1] })) === uris[0], "tokenURI on-chain points at the pinned metadata", "tokenURI mismatch");

// --------------------------------------------------------------------------------------------- 5
step("5. Trading is locked until the mint ends");
await expectRevert(ctx, "cannot list while the collection is still minting", minter.address, addr.market, ABI.market, "list", [token1, usd(1)], "MintNotEnded");
await expectRevert(ctx, "a non-creator cannot end the mint", minter.address, addr.nft, ABI.nft, "endMint", [collectionId], "NotCollectionCreator");
await tx(ctx, curator, addr.nft, ABI.nft, "endMint", [collectionId]);
check(await ctx.pub.readContract({ address: addr.nft, abi: ABI.nft, functionName: "isCollectionMintEnded", args: [collectionId] }), "curator ended the mint", "mint did not end");
await expectRevert(ctx, "minting is closed after endMint", minter.address, addr.nft, ABI.nft, "mint", [collectionId, uris[0], royalty.address, ROYALTY_BPS, MINT_PRICE], "MintAlreadyEnded");

// --------------------------------------------------------------------------------------------- 6
step("6. Listing, cancelling and buying");
await tx(ctx, minter, addr.nft, ABI.nft, "approve", [addr.market, token1]);
await expectRevert(ctx, "price 0 is rejected", minter.address, addr.market, ABI.market, "list", [token1, 0n], "PriceZero");
const L1_PRICE = usd(1.00), L2_PRICE = usd(0.50);
const listing1 = logsOf(await tx(ctx, minter, addr.market, ABI.market, "list", [token1, L1_PRICE]), ABI.market, "Listed")[0].args.listingId;
check((await ctx.pub.readContract({ address: addr.nft, abi: ABI.nft, functionName: "ownerOf", args: [token1] })).toLowerCase() === addr.market.toLowerCase(), `token #${token1} is in escrow in the Marketplace (listing #${listing1})`, "token not escrowed");
await expectRevert(ctx, "listing again right away hits the cooldown", minter.address, addr.market, ABI.market, "list", [token2, L2_PRICE], "ListTooSoon");

info("waiting 12s for the per-wallet list cooldown...");
await sleep(12_000);
await tx(ctx, minter, addr.nft, ABI.nft, "approve", [addr.market, token2]);
const listing2 = logsOf(await tx(ctx, minter, addr.market, ABI.market, "list", [token2, L2_PRICE]), ABI.market, "Listed")[0].args.listingId;
await expectRevert(ctx, "a non-seller cannot cancel a listing", buyer.address, addr.market, ABI.market, "cancelListing", [listing2], "NotSeller");
await tx(ctx, minter, addr.market, ABI.market, "cancelListing", [listing2]);
check((await ctx.pub.readContract({ address: addr.nft, abi: ABI.nft, functionName: "ownerOf", args: [token2] })).toLowerCase() === minter.address.toLowerCase(), `cancelling listing #${listing2} returned token #${token2} to the minter`, "cancel did not return the token");
await expectRevert(ctx, "a cancelled listing cannot be bought", buyer.address, addr.market, ABI.market, "buy", [listing2], "NotActive");
await expectRevert(ctx, "the seller cannot buy their own listing", minter.address, addr.market, ABI.market, "buy", [listing1], "CannotBuyOwnListing");

await tx(ctx, buyer, addr.usdc, ABI.usdc, "approve", [addr.market, L1_PRICE]);
const before = { seller: await usdcBalance(ctx, minter.address), roy: await usdcBalance(ctx, royalty.address), fee: await usdcBalance(ctx, feeRecipient), buyer: await usdcBalance(ctx, buyer.address) };
await tx(ctx, buyer, addr.market, ABI.market, "buy", [listing1]);
const after = { seller: await usdcBalance(ctx, minter.address), roy: await usdcBalance(ctx, royalty.address), fee: await usdcBalance(ctx, feeRecipient), buyer: await usdcBalance(ctx, buyer.address) };
const saleFee = cut(L1_PRICE, feeBps), saleRoyalty = cut(L1_PRICE, ROYALTY_BPS);
check((await ctx.pub.readContract({ address: addr.nft, abi: ABI.nft, functionName: "ownerOf", args: [token1] })).toLowerCase() === buyer.address.toLowerCase(), `buyer now owns token #${token1}`, "buyer does not own the token");
check(before.buyer - after.buyer === L1_PRICE, `buyer paid exactly $${fmt(L1_PRICE)}`, `buyer paid $${fmt(before.buyer - after.buyer)}`);
check(after.roy - before.roy === saleRoyalty, `royalty receiver got $${fmt(saleRoyalty)} (5%)`, `royalty got $${fmt(after.roy - before.roy)}`);
check(after.seller - before.seller === L1_PRICE - saleFee - saleRoyalty, `seller got $${fmt(L1_PRICE - saleFee - saleRoyalty)} (price - fee - royalty)`, `seller got $${fmt(after.seller - before.seller)}`);
if (!feeRecipientIsActor) check(after.fee - before.fee === saleFee, `platform fee $${fmt(saleFee)} reached the fee recipient`, `fee recipient got $${fmt(after.fee - before.fee)}`);
await expectRevert(ctx, "a sold listing cannot be bought twice", buyer.address, addr.market, ABI.market, "buy", [listing1], "NotActive");

// --------------------------------------------------------------------------------------------- 7
step("7. Offers: make, cancel, accept");
await tx(ctx, buyer, addr.usdc, ABI.usdc, "approve", [addr.offers, usd(0.40)]);
await expectRevert(ctx, "offer duration under 1 hour is rejected", buyer.address, addr.offers, ABI.offers, "makeOffer", [token2, usd(0.1), 60n], "DurationTooShort");
await expectRevert(ctx, "offer duration over 30 days is rejected", buyer.address, addr.offers, ABI.offers, "makeOffer", [token2, usd(0.1), 31n * 86400n], "DurationTooLong");
await expectRevert(ctx, "offer of $0 is rejected", buyer.address, addr.offers, ABI.offers, "makeOffer", [token2, 0n, 86400n], "AmountZero");
await expectRevert(ctx, "owner cannot make an offer on their own token", minter.address, addr.offers, ABI.offers, "makeOffer", [token2, usd(0.1), 86400n], "CannotOfferOnOwnToken");
await expectRevert(ctx, "offers on tokens that don't exist are rejected", buyer.address, addr.offers, ABI.offers, "makeOffer", [999_999n, usd(0.1), 86400n]);

const bal0 = await usdcBalance(ctx, buyer.address);
const offerA = logsOf(await tx(ctx, buyer, addr.offers, ABI.offers, "makeOffer", [token2, usd(0.10), 86400n]), ABI.offers, "OfferMade")[0].args.offerId;
check(bal0 - (await usdcBalance(ctx, buyer.address)) === usd(0.10), `offer #${offerA} escrowed $0.10`, "offer escrow amount wrong");
await expectRevert(ctx, "only the offerer can cancel an offer", minter.address, addr.offers, ABI.offers, "cancelOffer", [offerA], "NotOfferer");
await tx(ctx, buyer, addr.offers, ABI.offers, "cancelOffer", [offerA]);
check((await usdcBalance(ctx, buyer.address)) === bal0, `cancelling offer #${offerA} refunded the escrow in full`, "refund was not exact");
await expectRevert(ctx, "a cancelled offer cannot be accepted", minter.address, addr.offers, ABI.offers, "acceptOffer", [offerA], "OfferNotActive");

const OFFER_B = usd(0.30);
const offerB = logsOf(await tx(ctx, buyer, addr.offers, ABI.offers, "makeOffer", [token2, OFFER_B, 86400n]), ABI.offers, "OfferMade")[0].args.offerId;
await expectRevert(ctx, "someone who doesn't own the token cannot accept the offer", curator.address, addr.offers, ABI.offers, "acceptOffer", [offerB], "NotTokenOwner");
await tx(ctx, minter, addr.nft, ABI.nft, "approve", [addr.offers, token2]);
const o0 = { seller: await usdcBalance(ctx, minter.address), roy: await usdcBalance(ctx, royalty.address), fee: await usdcBalance(ctx, feeRecipient) };
await tx(ctx, minter, addr.offers, ABI.offers, "acceptOffer", [offerB]);
const o1 = { seller: await usdcBalance(ctx, minter.address), roy: await usdcBalance(ctx, royalty.address), fee: await usdcBalance(ctx, feeRecipient) };
const offFee = cut(OFFER_B, feeBps), offRoy = cut(OFFER_B, ROYALTY_BPS);
check((await ctx.pub.readContract({ address: addr.nft, abi: ABI.nft, functionName: "ownerOf", args: [token2] })).toLowerCase() === buyer.address.toLowerCase(), `accepting offer #${offerB} moved token #${token2} to the buyer`, "token did not move");
check(o1.seller - o0.seller === OFFER_B - offFee - offRoy, `seller got $${fmt(OFFER_B - offFee - offRoy)} (offer - fee - royalty)`, `seller got $${fmt(o1.seller - o0.seller)}`);
check(o1.roy - o0.roy === offRoy, `royalty receiver got $${fmt(offRoy)}`, `royalty got $${fmt(o1.roy - o0.roy)}`);
if (!feeRecipientIsActor) check(o1.fee - o0.fee === offFee, `platform fee $${fmt(offFee)} reached the fee recipient`, `fee got $${fmt(o1.fee - o0.fee)}`);
await expectRevert(ctx, "an accepted offer cannot be accepted twice", minter.address, addr.offers, ABI.offers, "acceptOffer", [offerB], "OfferNotActive");

// --------------------------------------------------------------------------------------------- 8
step("8. Owner-only safety controls");
const marketOwner = await ctx.pub.readContract({ address: addr.market, abi: ABI.market, functionName: "owner" });
await expectRevert(ctx, "a random wallet cannot use emergency withdraw", minter.address, addr.market, ABI.market, "emergencyWithdrawNft", [token1, minter.address], "OwnableUnauthorizedAccount");
await expectRevert(ctx, "even the owner cannot withdraw escrow without a 2-day pause first", marketOwner, addr.market, ABI.market, "emergencyWithdrawNft", [token1, marketOwner], "EmergencyDelayNotElapsed");

// --------------------------------------------------------------------------------------------- done
saveState({
  run: RUN, backend: BACKEND_URL, collectionId: collectionId.toString(), token1: token1.toString(), token2: token2.toString(),
  listing1: listing1.toString(), listing2: listing2.toString(), offerA: offerA.toString(), offerB: offerB.toString(),
  agentId, uris, usedPinnedMetadata: uris[0] !== FALLBACK_URI, feeBps: feeBps.toString(), feeRecipient,
  salePrice: fmt(L1_PRICE), offerAmount: fmt(OFFER_B), finishedAt: new Date().toISOString(),
});
info("state saved -> now run:  node scripts/test-api-and-tools.mjs");
finish("Marketplace cycle");
