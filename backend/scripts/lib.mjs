// Shared helpers for the OpenEden test scripts. Not run directly.
//
// All scripts act as THROWAWAY TEST WALLETS derived from one funder key, so you only ever
// fund / protect one key:
//   TEST_FUNDER_PRIVATE_KEY   a test wallet holding Base Sepolia ETH (~0.005) and testnet USDC (~$5)
//   BACKEND_URL               default: the v2 Render backend
//   CYCLE_RUN                 default "1". Each run creates a collection and a wallet may only create
//                             2 per week, so use CYCLE_RUN=2, 3, ... for a fresh set of actors.
//   BASE_RPC_URL              default https://sepolia.base.org
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, http, keccak256, toHex, toBytes, parseAbi, parseEventLogs, formatUnits, parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { createx402MCPClient } from "@x402/mcp";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";

export { formatUnits, parseUnits, keccak256, toBytes, parseEventLogs };

// Print one readable line instead of viem's multi-page error dump (set DEBUG=1 for the full error).
function explain(err) {
  const first = String(err?.shortMessage || err?.message || err).split(/\r?\n/)[0];
  const detail = err?.details && !first.includes(err.details) ? " (" + err.details + ")" : "";
  console.error(["", "✗ " + first + detail, ""].join(String.fromCharCode(10)));
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
}
process.on("uncaughtException", explain);
process.on("unhandledRejection", explain);

const here = path.dirname(fileURLToPath(import.meta.url));
export const STATE_FILE = path.join(here, ".cycle-state.json");

export const BACKEND_URL = (process.env.BACKEND_URL || "https://openeden-backend-qf4s.onrender.com").replace(/\/$/, "");
export const RPC_URL = process.env.BASE_RPC_URL || "https://sepolia.base.org";
export const RUN = process.env.CYCLE_RUN || "1";
export const IS_LOCAL = /localhost|127\.0\.0\.1/.test(BACKEND_URL);
// hard stop so a typo can never make a script pay real attention to a big x402 price ($0.25)
export const MAX_PAYMENT_BASE_UNITS = 250_000n;

// The backend allows 100 requests/minute per IP (x402 retries count too), so space calls out.
let lastCall = 0;
export async function throttle() {
  const gap = IS_LOCAL ? 0 : 900;
  const wait = lastCall + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

export const usd = (n) => parseUnits(String(n), 6);
export const fmt = (n) => formatUnits(n, 6);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------- ABIs
export const ABI = {
  usdc: parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function approve(address spender, uint256 amount) returns (bool)",
  ]),
  registry: parseAbi([
    "function isAgentWallet(address) view returns (bool)",
    "function agentIdOf(address) view returns (string)",
    "function owner() view returns (address)",
    "function registerAgent(address wallet, string agentId)",
  ]),
  nft: parseAbi([
    "function createCollection(uint256 maxSupply) returns (uint256)",
    "function setMintPrice(uint256 collectionId, uint256 priceUsdc)",
    "function endMint(uint256 collectionId)",
    "function mint(uint256 collectionId, string uri, address royaltyReceiver, uint96 royaltyBps, uint256 maxPriceUsdc) returns (uint256)",
    "function ownerOf(uint256) view returns (address)",
    "function approve(address to, uint256 tokenId)",
    "function tokenURI(uint256) view returns (string)",
    "function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address, uint256)",
    "function isCollectionMintEnded(uint256) view returns (bool)",
    "function collections(uint256) view returns (address creator, bool mintEndedManually, string creatorAgentId, uint256 maxSupply, uint256 mintedCount, uint256 mintPriceUsdc)",
    "function creatorAgentId(uint256) view returns (string)",
    "event CollectionCreated(uint256 indexed collectionId, address indexed creator, string creatorAgentId, uint256 maxSupply)",
    "event Minted(uint256 indexed tokenId, uint256 indexed collectionId, address indexed to, string agentId, string tokenURI)",
    "error NotAgent()",
    "error CannotMintOwnCollection()",
    "error PriceExceedsMax()",
    "error RoyaltyTooHigh()",
    "error MintTooSoon()",
    "error MintAlreadyEnded()",
    "error CollectionSoldOut()",
    "error CollectionWeeklyLimitReached()",
    "error NotCollectionCreator()",
    "error CollectionDoesNotExist()",
    "error CollectionSupplyTooHigh()",
    "error CollectionSupplyZero()",
    "error InvalidRoyalty()",
  ]),
  market: parseAbi([
    "function list(uint256 tokenId, uint256 price) returns (uint256)",
    "function buy(uint256 listingId)",
    "function cancelListing(uint256 listingId)",
    "function feeBps() view returns (uint96)",
    "function feeRecipient() view returns (address)",
    "function emergencyWithdrawNft(uint256 tokenId, address to)",
    "function owner() view returns (address)",
    "event Listed(uint256 indexed listingId, address indexed seller, uint256 tokenId, uint256 price)",
    "error NotAgent()",
    "error MintNotEnded()",
    "error CannotBuyOwnListing()",
    "error NotSeller()",
    "error NotActive()",
    "error PriceZero()",
    "error ListTooSoon()",
    "error DailyActionLimitReached()",
    "error EmergencyDelayNotElapsed()",
    "error OwnableUnauthorizedAccount(address account)",
  ]),
  offers: parseAbi([
    "function makeOffer(uint256 tokenId, uint256 amount, uint256 duration) returns (uint256)",
    "function cancelOffer(uint256 offerId)",
    "function acceptOffer(uint256 offerId)",
    "event OfferMade(uint256 indexed offerId, address indexed offerer, uint256 indexed tokenId, uint256 amount, uint256 expiresAt)",
    "error NotAgent()",
    "error AmountZero()",
    "error DurationTooShort()",
    "error DurationTooLong()",
    "error CannotOfferOnOwnToken()",
    "error NotOfferer()",
    "error NotTokenOwner()",
    "error OfferExpired()",
    "error OfferNotActive()",
    "error MintNotEnded()",
  ]),
  community: parseAbi([
    "function createCommunity(string slug)",
    "function join(string slug)",
    "function leave(string slug)",
    "function isMember(bytes32, address) view returns (bool)",
    "error NotAgent()",
    "error AlreadyExists()",
    "error DoesNotExist()",
    "error AlreadyMember()",
    "error NotMember()",
    "error CreateTooSoon()",
  ]),
};

// ----------------------------------------------------------------- output
export const results = { pass: 0, fail: 0, warn: 0 };
export const ok = (m) => { results.pass++; console.log(`  ✓ ${m}`); };
export const bad = (m) => { results.fail++; console.log(`  ✗ ${m}`); };
export const warn = (m) => { results.warn++; console.log(`  ! ${m}`); };
export const info = (m) => console.log(`    ${m}`);
export const step = (m) => console.log(`\n${m}`);
export const check = (cond, good, badMsg) => (cond ? ok(good) : bad(badMsg), !!cond);
export const die = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };
export function finish(title) {
  console.log(`\n${results.fail === 0 ? "✓" : "✗"} ${title}: ${results.pass} passed, ${results.fail} failed, ${results.warn} warnings\n`);
  process.exit(results.fail === 0 ? 0 : 1);
}

// ----------------------------------------------------------------- setup
export function normalizeKey(raw, label) {
  let key = (raw || "").trim().replace(/^["']|["']$/g, "");
  if (/^[0-9a-fA-F]{64}$/.test(key)) key = `0x${key}`;
  if (!key) die(`Set ${label} first, e.g.  $env:${label}="0x..."  (a throwaway TEST wallet - never one of your real wallets)`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) die(`${label} is not a valid key (expected 0x + 64 hex characters; got ${key.length}).`);
  return key;
}

const derive = (funderKey, label) => privateKeyToAccount(keccak256(toHex(`${funderKey}:${RUN}:${label}`)));

export async function setup() {
  const funderKey = normalizeKey(process.env.TEST_FUNDER_PRIVATE_KEY, "TEST_FUNDER_PRIVATE_KEY");
  const funder = privateKeyToAccount(funderKey);
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });

  let info1;
  try {
    const res = await fetch(`${BACKEND_URL}/api/contract-info`, { signal: AbortSignal.timeout(60_000) }); // free Render plans cold-start
    info1 = await res.json();
  } catch (err) {
    die(`cannot reach ${BACKEND_URL}: ${err.message}`);
  }
  const chainId = Number(info1.chainId);

  const actors = {
    curator: derive(funderKey, "curator"),
    minter: derive(funderKey, "minter"),
    buyer: derive(funderKey, "buyer"),
    altWallet: derive(funderKey, "alt-wallet"),       // linked to the curator's agent by link_wallet
    altWallet2: derive(funderKey, "alt-wallet-2"),    // used for a negative link_wallet test
    royalty: derive(funderKey, "royalty-receiver"),   // only ever RECEIVES royalties
    stranger: derive(funderKey, "unregistered"),      // never registered; used for negative tests
  };

  return {
    funder, pub, chainId, actors,
    addr: {
      registry: info1.agentRegistryAddress, nft: info1.nftContractAddress, market: info1.marketplaceContractAddress,
      offers: info1.offersContractAddress, community: info1.communityRegistryAddress, usdc: info1.usdcAddress,
    },
  };
}

const walletClients = new Map();
function wallet(account) {
  if (!walletClients.has(account.address)) walletClients.set(account.address, createWalletClient({ account, chain: baseSepolia, transport: http(RPC_URL) }));
  return walletClients.get(account.address);
}

/// Send a transaction and require it to succeed. Returns the receipt.
export async function tx(ctx, account, address, abi, functionName, args = []) {
  const hash = await wallet(account).writeContract({ address, abi, functionName, args });
  const receipt = await ctx.pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted (tx ${hash})`);
  return receipt;
}

/// Assert that a call would revert (simulated - costs nothing, needs no funds).
export async function expectRevert(ctx, label, account, address, abi, functionName, args, errorName) {
  try {
    await ctx.pub.simulateContract({ account, address, abi, functionName, args });
    bad(`${label}: expected a revert but it would succeed`);
  } catch (err) {
    const text = `${err?.shortMessage || ""} ${err?.message || ""} ${err?.cause?.data?.errorName || ""} ${err?.cause?.reason || ""}`;
    check(!errorName || text.includes(errorName), `${label} -> reverts${errorName ? ` (${errorName})` : ""}`, `${label}: reverted, but not with ${errorName}: ${text.slice(0, 160)}`);
  }
}

export const usdcBalance = (ctx, who) => ctx.pub.readContract({ address: ctx.addr.usdc, abi: ABI.usdc, functionName: "balanceOf", args: [who] });

// ----------------------------------------------------------------- funding
export async function ensureFunded(ctx, plan) {
  // plan: [{ account, eth: "0.0006", usdc: 1.0 }, ...]  (amounts are TARGET balances, topped up only if below)
  const fundBal = await usdcBalance(ctx, ctx.funder.address);
  const fundEth = await ctx.pub.getBalance({ address: ctx.funder.address });
  const needUsdc = plan.reduce((s, p) => s + usd(p.usdc || 0), 0n);
  info(`funder ${ctx.funder.address}: ${formatUnits(fundEth, 18)} ETH, ${fmt(fundBal)} USDC`);

  for (const p of plan) {
    // local chains have free ETH and a much higher gas price than Base Sepolia, so be generous there
    const ethTarget = parseUnits(p.eth || "0", 18) * (IS_LOCAL ? 5000n : 1n);
    const ethHave = await ctx.pub.getBalance({ address: p.account.address });
    if (ethHave < ethTarget) {
      if (fundEth < ethTarget - ethHave) die(`funder has too little ETH. Send some Base Sepolia ETH to ${ctx.funder.address} (https://portal.cdp.coinbase.com/products/faucet).`);
      const hash = await wallet(ctx.funder).sendTransaction({ to: p.account.address, value: ethTarget - ethHave });
      await ctx.pub.waitForTransactionReceipt({ hash });
    }
    const usdcTarget = usd(p.usdc || 0);
    const usdcHave = await usdcBalance(ctx, p.account.address);
    if (usdcHave < usdcTarget) {
      const top = usdcTarget - usdcHave;
      const left = await usdcBalance(ctx, ctx.funder.address);
      if (left < top) die(`funder has too little USDC (needs about $${fmt(needUsdc)} in total). Get free test USDC at https://faucet.circle.com (Base Sepolia) for ${ctx.funder.address}.`);
      await tx(ctx, ctx.funder, ctx.addr.usdc, ABI.usdc, "transfer", [p.account.address, top]);
    }
  }
}

// ----------------------------------------------------------------- MCP + paid REST + signed REST
export async function connectMcp(ctx, account) {
  const state = { lastPaid: 0n };
  const client = createx402MCPClient({
    name: "openeden-test", version: "1.0.0",
    schemes: [{ network: `eip155:${ctx.chainId}`, client: new ExactEvmScheme(account) }],
    autoPayment: true,
    onPaymentRequested: async ({ toolName, paymentRequired }) => {
      const amount = BigInt(paymentRequired.accepts[0].amount);
      if (amount > MAX_PAYMENT_BASE_UNITS) { bad(`refusing to pay $${fmt(amount)} for ${toolName} (cap $${fmt(MAX_PAYMENT_BASE_UNITS)})`); return false; }
      state.lastPaid = amount;
      return true;
    },
  });
  await client.connect(new SSEClientTransport(new URL(`${BACKEND_URL}/sse`)));
  return {
    client,
    /// Returns { data, isError, paid } where data is the parsed JSON text of the tool result.
    async call(name, args) {
      state.lastPaid = 0n;
      const r = await client.callTool(name, args);
      const text = r?.content?.[0]?.text ?? "";
      let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return { data, isError: !!r.isError, paid: !!r.paymentMade };
    },
    close: async () => { try { await client.close(); } catch { /* ignore */ } },
  };
}

export function payingFetch(ctx, account) {
  return wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: `eip155:${ctx.chainId}`, client: new ExactEvmScheme(account) }] });
}

/// A wallet-signed REST request (see the "requestSigning" block of get_contract_info).
/// `fetchFn` is plain fetch for free routes or payingFetch() for x402-gated ones.
export async function signedRequest({ account, agentId, method, path: p, body, fetchFn = fetch, rawBody, rawBuffer, contentType = "application/json" }) {
  const raw = rawBuffer ?? rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  const rawBytes = raw === undefined ? undefined : (typeof raw === "string" ? new TextEncoder().encode(raw) : raw);
  const ts = String(Date.now());
  const message = [
    "OpenEden request", `Agent: ${agentId}`, `Method: ${method}`, `Path: ${p}`, `Timestamp: ${ts}`,
    `Body: ${keccak256(rawBytes && rawBytes.length ? rawBytes : "0x")}`,
  ].join("\n");
  const signature = await account.signMessage({ message });
  await throttle();
  const res = await fetchFn(`${BACKEND_URL}${p}`, {
    method,
    headers: { "content-type": contentType, "x-agent-id": agentId, "x-timestamp": ts, "x-signature": signature },
    body: raw,
  });
  let data; try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}

export async function getJson(p) {
  await throttle();
  const res = await fetch(`${BACKEND_URL}${p}`);
  let data; try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}

export async function waitFor(label, fn, { timeoutMs = 90_000, everyMs = 2_000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(everyMs);
  }
}

// ----------------------------------------------------------------- agent registration (paid, skipped if already done)
export async function ensureRegistered(ctx, account, name) {
  const already = await ctx.pub.readContract({ address: ctx.addr.registry, abi: ABI.registry, functionName: "isAgentWallet", args: [account.address] });
  if (already) {
    const agentId = await ctx.pub.readContract({ address: ctx.addr.registry, abi: ABI.registry, functionName: "agentIdOf", args: [account.address] });
    info(`${name}: already registered as ${agentId} (no fee charged)`);
    return agentId;
  }
  const mcp = await connectMcp(ctx, account);
  const timestamp = Date.now();
  const signature = await account.signMessage({ message: `Register as an AI NFT Marketplace agent.\nWallet: ${account.address}\nTimestamp: ${timestamp}` });
  const r = await mcp.call("register_agent", { name, walletAddress: account.address, timestamp, signature });
  await mcp.close();
  if (!r.data.agentId) die(`registering ${name} failed: ${JSON.stringify(r.data)}`);
  if (r.data.onChainRegistration?.success !== true) die(`registering ${name}: on-chain allowlisting failed: ${JSON.stringify(r.data)}`);
  info(`${name}: registered as ${r.data.agentId}${r.paid ? " (fee paid via x402)" : " (no fee requested)"}`);
  return r.data.agentId;
}

// ----------------------------------------------------------------- shared state between scripts
export function saveState(obj) { fs.writeFileSync(STATE_FILE, JSON.stringify(obj, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2)); }
export function loadState() {
  if (!fs.existsSync(STATE_FILE)) die("No saved state. Run  node scripts/test-marketplace-cycle.mjs  first.");
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

export function logsOf(receipt, abi, eventName) {
  return parseEventLogs({ abi, logs: receipt.logs, eventName });
}
