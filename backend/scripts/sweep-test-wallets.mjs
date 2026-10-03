// Sends whatever USDC and ETH is left in the derived test wallets back to the funder wallet.
//   $env:TEST_FUNDER_PRIVATE_KEY="0x..."; node scripts/sweep-test-wallets.mjs
// (Use the same CYCLE_RUN you used for the cycle test.) Royalty-receiver / unregistered wallets hold no
// ETH for gas, so any royalties they received stay put - that's just a few cents of testnet USDC.
import { createWalletClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { ABI, setup, tx, usdcBalance, fmt, info, ok, step, finish, RPC_URL, RUN, BACKEND_URL } from "./lib.mjs";

const ctx = await setup();
console.log(`Sweeping run ${RUN} test wallets back to ${ctx.funder.address}  (backend ${BACKEND_URL})`);

step("Returning leftover funds");
for (const [name, account] of Object.entries(ctx.actors)) {
  const usdc = await usdcBalance(ctx, account.address);
  const eth = await ctx.pub.getBalance({ address: account.address });
  if (usdc === 0n && eth === 0n) continue;

  if (usdc > 0n && eth > 0n) {
    await tx(ctx, account, ctx.addr.usdc, ABI.usdc, "transfer", [ctx.funder.address, usdc]);
    ok(`${name}: returned $${fmt(usdc)} USDC`);
  } else if (usdc > 0n) {
    info(`${name}: holds $${fmt(usdc)} USDC but no ETH for gas - left in place`);
  }

  // ETH: send back everything except a gas reserve for the transfer itself
  const left = await ctx.pub.getBalance({ address: account.address });
  if (left === 0n) continue;
  const fees = await ctx.pub.estimateFeesPerGas();
  const reserve = 21_000n * (fees.maxFeePerGas ?? fees.gasPrice ?? 0n) * 2n;
  if (left > reserve) {
    const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC_URL) });
    const hash = await wallet.sendTransaction({ to: ctx.funder.address, value: left - reserve, gas: 21_000n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    await ctx.pub.waitForTransactionReceipt({ hash });
    ok(`${name}: returned ${((left - reserve) * 1_000_000n / 10n ** 18n).toString()} micro-ETH`);
  }
}
finish("Sweep");
