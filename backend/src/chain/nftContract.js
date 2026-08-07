import { publicClient } from "./viemClient.js";
import { config } from "../config.js";

/// The backend no longer mints — agents call AgentNFT.mint() themselves
/// with their own wallet. This file keeps a minimal read-only ABI +
/// helper for the backend's own read needs (e.g. confirming a tokenId's
/// current owner when indexing) — no write functions, on purpose.
export const AGENT_NFT_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "creatorAgentId",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
];

export async function getNftOwner(tokenId) {
  if (!config.chain.nftContractAddress) throw new Error("NFT_CONTRACT_ADDRESS not configured");
  return publicClient.readContract({
    address: config.chain.nftContractAddress,
    abi: AGENT_NFT_ABI,
    functionName: "ownerOf",
    args: [tokenId],
  });
}
