import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";
import { config } from "../config.js";

const chain = config.chain.chainId === 8453 ? base : baseSepolia;

export const publicClient = createPublicClient({
  chain,
  transport: http(config.chain.rpcUrl),
});

// Only construct a wallet client if a relayer key is actually configured —
// read-only routes (browse, get NFT) shouldn't require it.
export const relayerAccount = config.chain.relayerPrivateKey
  ? privateKeyToAccount(config.chain.relayerPrivateKey)
  : null;

export const walletClient = relayerAccount
  ? createWalletClient({
      account: relayerAccount,
      chain,
      transport: http(config.chain.rpcUrl),
    })
  : null;
