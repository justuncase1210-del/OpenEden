// End-to-end test of agent registration against a LIVE OpenEden backend.
//
//   cd backend
//   $env:TEST_AGENT_PRIVATE_KEY="0x..."        # a THROWAWAY test wallet - never one of your 3 real wallets
//   node scripts/test-register-agent.mjs
//
// Optional: $env:BACKEND_URL="https://your-backend.onrender.com"
//
// What it does (and what it costs):
//   1. reads the wallet's Base Sepolia USDC balance (needs >= $0.10 of TESTNET USDC)
//   2. connects to the MCP endpoint and calls get_contract_info (free)
//   3. signs the registration message with the wallet and calls register_agent.
//      This is an x402 PAID tool: it pays ~$0.05 testnet USDC (the script refuses to pay more than $0.25)
//   4. checks on-chain that AgentRegistry now lists the wallet under the returned agentId
//   5. makes signed REST requests to prove wallet-signature auth works, and that
//      forged / replayed / tampered requests are rejected (free, no payment)
//
// Nothing here uses real money: Base Sepolia is a test network.

import { createPublicClient, http, keccak256, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { createx402MCPClient } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const BACKEND_URL = (process.env.BACKEND_URL || "https://openeden-backend-qf4s.onrender.com").replace(/\/$/, "");
const RPC_URL = process.env.BASE_RPC_URL || "https://sepolia.base.org";
const MAX_PAYMENT_BASE_UNITS = 250_000n; // $0.25 in USDC's 6 decimals - hard safety cap

// ---- tiny output helpers -------------------------------------------------
let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { failures++; console.log(`  ✗ ${msg}`); };
const info = (msg) => console.log(`    ${msg}`);
const step = (msg) => console.log(`\n${msg}`);
const check = (cond, good, badMsg) => (cond ? ok(good) : bad(badMsg));
const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };

// ---- wallet --------------------------------------------------------------
let key = (process.env.TEST_AGENT_PRIVATE_KEY || "").trim().replace(/^["']|["']$/g, "");
if (/^[0-9a-fA-F]{64}$/.test(key)) key = `0x${key}`;
if (!key) die('Set TEST_AGENT_PRIVATE_KEY first, e.g.  $env:TEST_AGENT_PRIVATE_KEY="0x..."  (use a throwaway test wallet)');
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) die(`TEST_AGENT_PRIVATE_KEY is not a valid key (expected 0x + 64 hex characters; got ${key.length} characters).`);
const account = privateKeyToAccount(key);

console.log(`OpenEden registration test`);
console.log(`  backend: ${BACKEND_URL}`);
console.log(`  wallet:  ${account.address}`);

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
const USDC_ABI = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }];
const REGISTRY_ABI = [
  { type: "function", name: "isAgentWallet", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "agentIdOf", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "string" }] },
];

// ---- 0. backend reachable? ----------------------------------------------
step("0. Backend health");
try {
  const h = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(60_000) }); // free Render plans cold-start
  const body = await h.json();
  check(h.ok && body.ok, `backend is up (environment: ${body.environment})`, `backend returned HTTP ${h.status}`);
} catch (err) {
  die(`cannot reach ${BACKEND_URL}/health: ${err.message}`);
}
const contractInfo = await (await fetch(`${BACKEND_URL}/api/contract-info`)).json();
info(`registry: ${contractInfo.agentRegistryAddress}`);

// ---- 1. USDC balance -----------------------------------------------------
step("1. Wallet USDC balance (Base Sepolia)");
const usdc = contractInfo.usdcAddress;
const balance = await publicClient.readContract({ address: usdc, abi: USDC_ABI, functionName: "balanceOf", args: [account.address] });
info(`${formatUnits(balance, 6)} USDC`);
if (balance < 100_000n) {
  die(`This wallet needs at least $0.10 of Base Sepolia USDC. Get free test USDC at https://faucet.circle.com (choose "Base Sepolia"), send it to ${account.address}, then re-run.`);
}
ok("enough testnet USDC to pay the registration fee");

// ---- 2. connect MCP client ----------------------------------------------
step("2. Connect to the MCP endpoint");
let paid = null;
const client = createx402MCPClient({
  name: "openeden-registration-test",
  version: "1.0.0",
  schemes: [{ network: `eip155:${contractInfo.chainId}`, client: new ExactEvmScheme(account) }],
  autoPayment: true,
  onPaymentRequested: async ({ toolName, paymentRequired }) => {
    const amount = BigInt(paymentRequired.accepts[0].amount);
    info(`server asks for ${formatUnits(amount, 6)} USDC for "${toolName}"`);
    if (amount > MAX_PAYMENT_BASE_UNITS) {
      bad(`refusing to pay ${formatUnits(amount, 6)} USDC - above this script's $${formatUnits(MAX_PAYMENT_BASE_UNITS, 6)} safety cap`);
      return false;
    }
    paid = amount;
    return true;
  },
});
await client.connect(new SSEClientTransport(new URL(`${BACKEND_URL}/sse`)));
ok("connected over SSE");

const parse = (result) => {
  const text = result?.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return { raw: text }; }
};

const info1 = parse(await client.callTool("get_contract_info", {}));
check(info1.registrationMessageFormat && info1.requestSigning, "get_contract_info returns the signing formats", "get_contract_info is missing the signing formats");

// ---- 3. register (paid) ---------------------------------------------------
step("3. register_agent (paid via x402)");
const timestamp = Date.now();
const regMessage = `Register as an AI NFT Marketplace agent.\nWallet: ${account.address}\nTimestamp: ${timestamp}`;
const signature = await account.signMessage({ message: regMessage });
const result = await client.callTool("register_agent", {
  name: `test-agent-${timestamp.toString(36)}`,
  walletAddress: account.address,
  description: "registration test script",
  timestamp,
  signature,
});
const reg = parse(result);
info(JSON.stringify(reg));
if (!reg.agentId) die("register_agent did not return an agentId (see output above). Nothing more to test.");
ok(`registered - agentId = ${reg.agentId}`);
check(reg.onChainRegistration?.success === true, "backend reports on-chain allowlisting succeeded", "backend reports on-chain allowlisting FAILED");
if (reg.onChainRegistration?.transactionHash) info(`allowlist tx: https://sepolia.basescan.org/tx/${reg.onChainRegistration.transactionHash}`);
if (result.paymentMade) {
  ok(`x402 payment settled${result.paymentResponse?.transaction ? ` (tx ${result.paymentResponse.transaction})` : ""}`);
} else if (paid === null) {
  info("no payment was requested (registration fee is currently 0)");
}

// ---- 4. on-chain verification ---------------------------------------------
step("4. Verify on-chain");
const isAgent = await publicClient.readContract({ address: contractInfo.agentRegistryAddress, abi: REGISTRY_ABI, functionName: "isAgentWallet", args: [account.address] });
check(isAgent === true, "AgentRegistry.isAgentWallet(wallet) == true", "wallet is NOT allowlisted on-chain");
const onChainId = await publicClient.readContract({ address: contractInfo.agentRegistryAddress, abi: REGISTRY_ABI, functionName: "agentIdOf", args: [account.address] });
check(onChainId === reg.agentId, `AgentRegistry.agentIdOf(wallet) matches (${onChainId})`, `on-chain agentId "${onChainId}" differs from "${reg.agentId}"`);

// ---- 5. signed REST requests ----------------------------------------------
step("5. Wallet-signed REST requests");
async function signedRequest({ signer = account, agentId = reg.agentId, method, path, body, sendBody }) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const ts = String(Date.now());
  const message = [
    "OpenEden request",
    `Agent: ${agentId}`,
    `Method: ${method}`,
    `Path: ${path}`,
    `Timestamp: ${ts}`,
    `Body: ${keccak256(raw ? new TextEncoder().encode(raw) : "0x")}`,
  ].join("\n");
  const sig = await signer.signMessage({ message });
  const headers = { "content-type": "application/json", "x-agent-id": agentId, "x-timestamp": ts, "x-signature": sig };
  const send = () => fetch(`${BACKEND_URL}${path}`, { method, headers, body: sendBody ?? raw });
  return { first: await send(), replay: send };
}

// A correctly signed request must get PAST authentication. /api/watchlist isn't payment-gated and
// collection 999999 doesn't exist, so "404 not found" proves auth passed and the business logic ran.
const good = await signedRequest({ method: "POST", path: "/api/watchlist", body: { collectionId: 999999 } });
check(good.first.status === 404, "correctly signed request accepted (reached the handler; 404 = no such collection)", `signed request got HTTP ${good.first.status}, expected 404`);

const replay = await good.replay();
check(replay.status === 401, "replaying the same signature is rejected (401)", `replay got HTTP ${replay.status}, expected 401`);

const stranger = privateKeyToAccount("0x" + "11".repeat(32));
const forged = await signedRequest({ signer: stranger, method: "POST", path: "/api/watchlist", body: { collectionId: 1 } });
check(forged.first.status === 403, "another wallet claiming your agentId is rejected (403)", `forged request got HTTP ${forged.first.status}, expected 403`);

const tampered = await signedRequest({ method: "POST", path: "/api/watchlist", body: { collectionId: 1 }, sendBody: JSON.stringify({ collectionId: 2 }) });
check(tampered.first.status === 403, "body changed after signing is rejected (403)", `tampered request got HTTP ${tampered.first.status}, expected 403`);

const unsigned = await fetch(`${BACKEND_URL}/api/watchlist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: reg.agentId, collectionId: 1 }) });
check(unsigned.status === 401, "unsigned request that only names your agentId is rejected (401)", `unsigned request got HTTP ${unsigned.status}, expected 401`);

// ---- summary --------------------------------------------------------------
try { await client.close(); } catch { /* already closed */ }
console.log(failures === 0 ? `\n✓ ALL CHECKS PASSED (agentId ${reg.agentId})\n` : `\n✗ ${failures} CHECK(S) FAILED - see above\n`);
process.exit(failures === 0 ? 0 : 1);
