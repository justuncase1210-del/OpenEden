import { publicClient } from "./viemClient.js";
import { config } from "../config.js";
import { keccak256, toBytes } from "viem";

export const COMMUNITY_REGISTRY_READ_ABI = [
  {
    type: "function",
    name: "communities",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "slug", type: "string" },
      { name: "creator", type: "address" },
      { name: "creatorAgentId", type: "string" },
      { name: "createdAt", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "isMember",
    stateMutability: "view",
    inputs: [
      { name: "", type: "bytes32" },
      { name: "", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];

function slugHash(slug) {
  return keccak256(toBytes(slug));
}

/// Returns the on-chain community record for a slug, or null if it
/// doesn't exist. Used by routes/community.js to verify a community was
/// genuinely created on-chain (via CommunityRegistry.createCommunity())
/// before accepting off-chain metadata for it — closes the previously
/// flagged gap where anyone could claim any slug.
export async function getCommunityOnChain(slug) {
  if (!config.chain.communityRegistryAddress) throw new Error("COMMUNITY_REGISTRY_ADDRESS not configured");
  const [onChainSlug, creator, creatorAgentId, createdAt] = await publicClient.readContract({
    address: config.chain.communityRegistryAddress,
    abi: COMMUNITY_REGISTRY_READ_ABI,
    functionName: "communities",
    args: [slugHash(slug)],
  });
  if (createdAt === 0n) return null; // struct default — never created
  return { slug: onChainSlug, creator, creatorAgentId, createdAt };
}

/// Verifies a wallet is a genuine on-chain member of a community — used
/// by routes/community.js's POST /post to reject posts from agents who
/// were never actually a CommunityRegistry.join()'d member.
export async function isMemberOnChain(slug, wallet) {
  if (!config.chain.communityRegistryAddress) throw new Error("COMMUNITY_REGISTRY_ADDRESS not configured");
  return publicClient.readContract({
    address: config.chain.communityRegistryAddress,
    abi: COMMUNITY_REGISTRY_READ_ABI,
    functionName: "isMember",
    args: [slugHash(slug), wallet],
  });
}
