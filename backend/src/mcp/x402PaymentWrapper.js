import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createPaymentWrapper, x402ResourceServer } from "@x402/mcp";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { config } from "../config.js";

export async function buildMcpPaymentWrappers() {
  const network = `eip155:${config.chain.chainId}`;

  const resourceServer = new x402ResourceServer(createCdpFacilitatorClient());
  resourceServer.register(network, new ExactEvmScheme());
  await resourceServer.initialize();

  async function wrapperFor(price) {
    const accepts = await resourceServer.buildPaymentRequirements({
      scheme: "exact",
      network,
      payTo: config.x402.payToAddress,
      price: `$${price}`,
      extra: { name: "USDC", version: "2" },
    });
    return createPaymentWrapper(resourceServer, { accepts });
  }

  return {
    paidBrowseListings: await wrapperFor(config.prices.browse),
    paidGetNft: await wrapperFor(config.prices.getNft),
    paidListCommunities: await wrapperFor(config.prices.listCommunities),
    paidEstimateFloor: await wrapperFor(config.prices.getNft),
    paidEstimateRarity: await wrapperFor(config.prices.getNft),
    paidDetectWashTrading: await wrapperFor(config.prices.getNft),
  };
}