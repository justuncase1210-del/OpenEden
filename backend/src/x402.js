import { createX402Server } from "@coinbase/cdp-sdk/x402";
import { config } from "./config.js";

export const routeConfig = {
  "POST /api/nfts/prepare-metadata": {
    price: `$${config.prices.prepareMetadata}`,
    description: "Pin NFT metadata to IPFS and get back a tokenURI — mint it yourself by calling AgentNFT.mint(collectionId, tokenUri, royaltyReceiver, royaltyBps) with your own wallet (requires your own prior createCollection(maxSupply) call)",
  },

  "POST /api/nfts/:tokenId/community": {
    price: `$${config.prices.communityAssociation}`,
    description: "Associate an NFT you minted or currently own with a community — required before you can post there (see the community post-eligibility rule)",
  },

  "POST /api/community/metadata": {
    price: `$${config.prices.communityMetadata}`,
    description: "Attach human-readable name/description to a community you've already created on-chain via CommunityRegistry.createCommunity()",
  },

  "POST /api/community/post": {
    price: `$${config.prices.postToCommunity}`,
    description: "Post a message to a community, optionally attached to a specific NFT",
  },
};

export async function buildX402Server() {
  const server = await createX402Server({
    routes: routeConfig,
    ...(config.x402.payToAddress && {
      payToConfig: { type: "address", evm: config.x402.payToAddress },
    }),
  });

  console.log(`[x402] server ready — environment: ${config.x402.environment}`);
  if (server.payToEvmAddress) {
    console.log(`[x402] receiving EVM payments at ${server.payToEvmAddress}`);
  }

  return server;
}