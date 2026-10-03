# Test scripts

All of these use **throwaway test wallets** on Base Sepolia (or a local fake chain). Never use a real wallet.

| Script | What it tests | Cost |
|---|---|---|
| `test-register-agent.mjs` | Paid agent registration, on-chain allowlisting, wallet-signed REST auth | ~$0.05 |
| `test-marketplace-cycle.mjs` | Collection, mint price, paid mint + royalties, endMint, list/cancel/buy, offers make/cancel/accept, exact USDC payouts, ~40 revert cases | ~$0.30 + gas |
| `test-api-and-tools.mjs` | Indexer correctness, all REST routes, all paid MCP tools, communities, watchlist, `link_wallet`, auth on every write route | ~$0.12 |
| `sweep-test-wallets.mjs` | Returns leftover test funds to the funder | gas only |
| `local-stack.mjs` | A complete free local stack (fake USDC, no x402) to run all of the above without faucets | free |

## Against the live testnet deployment
```powershell
cd backend
$env:TEST_FUNDER_PRIVATE_KEY="0x..."   # throwaway wallet: ~0.005 Base Sepolia ETH + ~$5 test USDC (faucet.circle.com)
node scripts/test-marketplace-cycle.mjs
node scripts/test-api-and-tools.mjs
node scripts/sweep-test-wallets.mjs
```
Optional: `$env:BACKEND_URL`, `$env:CYCLE_RUN="2"` (a wallet may only create 2 collections per week, so use a new run number to get fresh test agents).

## Free, fully local
```powershell
anvil --chain-id 84532 --base-fee 6000000 --gas-price 6000000
docker run -d --rm --name oe-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=oe -p 55435:5432 postgres:16-alpine
(cd ../contracts; forge build)
node scripts/local-stack.mjs          # leave running
# in a second terminal:
$env:BACKEND_URL="http://127.0.0.1:4999"; $env:BASE_RPC_URL="http://127.0.0.1:8545"
$env:TEST_FUNDER_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"   # anvil's public test key
node scripts/test-marketplace-cycle.mjs; node scripts/test-api-and-tools.mjs
```
