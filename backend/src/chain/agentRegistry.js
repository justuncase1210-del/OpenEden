import { publicClient, walletClient } from "./viemClient.js";
import { config } from "../config.js";
import { pool } from "../db.js";

export const AGENT_REGISTRY_ABI = [
  {
    type: "function",
    name: "registerAgent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "wallet", type: "address" },
      { name: "agentId", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "isAgentWallet",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
];

/// THE critical call — without this, an agent exists in Postgres but
/// NEVER passes Marketplace/CommunityRegistry's onlyAgent gate. Every
/// caller of this (see register_agent in mcp/server.js) MUST check the
/// result and surface failure clearly — a silent failure here means an
/// agent believes they're registered but every list/buy/createCommunity/
/// join call they attempt will revert on-chain, with no obvious link back
/// to "you were never actually allowlisted."
///
/// SECURITY: register_agent (the MCP tool that calls this) is intentionally
/// free — friction on onboarding is bad — but "free" plus "triggers a real
/// on-chain transaction paid for by the backend's own relayer wallet" is a
/// gas-drain vector: nothing stops spamming registrations to burn your
/// gas. Two defenses here: (1) skip the on-chain call entirely if the
/// wallet is already registered (idempotent — re-registering the same
/// wallet wastes gas for no on-chain effect), and (2) a simple in-memory
/// rate limiter on this specific function, since it's the expensive
/// operation to protect regardless of which IP/session is calling it.
/// This is a coarse, single-process circuit breaker, not per-caller
/// throttling — see the rate limiter comment below for what it does and
/// doesn't cover.
const MAX_REGISTRATIONS_PER_MINUTE = 10;

/// Global circuit breaker on relayer gas spend. Counted from Postgres
/// (agent_wallets.linked_at) instead of process memory, so it survives
/// restarts and holds across multiple API instances.
async function checkRegistrationRateLimit() {
  const { rows } = await pool.query("SELECT COUNT(*) FROM agent_wallets WHERE linked_at > now() - interval '1 minute'");
  if (parseInt(rows[0].count, 10) > MAX_REGISTRATIONS_PER_MINUTE) {
    throw new Error(`Registration rate limit exceeded (max ${MAX_REGISTRATIONS_PER_MINUTE} per minute across all callers) - try again shortly.`);
  }
}

export async function registerAgentOnChain({ wallet, agentId }) {
  if (!walletClient) throw new Error("RELAYER_PRIVATE_KEY not configured");
  if (!config.chain.agentRegistryAddress) throw new Error("AGENT_REGISTRY_ADDRESS not configured");

  const alreadyRegistered = await isAgentWalletOnChain(wallet);
  if (alreadyRegistered) {
    console.log(`[agentRegistry] ${wallet} already registered on-chain — skipping redundant tx`);
    return { transactionHash: null, alreadyRegistered: true };
  }

  await checkRegistrationRateLimit();

  const hash = await walletClient.writeContract({
    address: config.chain.agentRegistryAddress,
    abi: AGENT_REGISTRY_ABI,
    functionName: "registerAgent",
    args: [wallet, agentId],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { transactionHash: hash, blockNumber: receipt.blockNumber };
}

export async function isAgentWalletOnChain(wallet) {
  if (!config.chain.agentRegistryAddress) throw new Error("AGENT_REGISTRY_ADDRESS not configured");
  return publicClient.readContract({
    address: config.chain.agentRegistryAddress,
    abi: AGENT_REGISTRY_ABI,
    functionName: "isAgentWallet",
    args: [wallet],
  });
}
