---
name: Real trading architecture
description: Jupiter v6 swaps, Solana wallet service, async call chain, key design decisions for live trading
---

## Wallet service
- `solana-wallet.service.ts` loads keypair from `SOLANA_PRIVATE_KEY` env (base58 encoded)
- Uses Helius RPC if `HELIUS_API_KEY` set, else public mainnet
- `@solana/web3.js` is EXTERNALIZED in `build.mjs` (not bundled), loaded from node_modules at runtime
- `bs58` is also externalized

## Jupiter swap service
- `jupiter-swap.service.ts` — buy (SOL→token) and sell (token→SOL)
- **IMPORTANT:** Use Jupiter Lite API — `https://lite-api.jup.ag/swap/v1/quote` and `.../swap`
- Old `quote-api.jup.ag` domain is dead (ENOTFOUND) — never use it again
- Lite API swap body uses `prioritizationFeeLamports: <number>` (plain int, NOT the v6 nested object)
- Lite API still returns `swapTransaction` field (same as v6) — no field name change needed
- SOL mint: `So11111111111111111111111111111111111111112`

## Async call chain (critical)
- `enterPosition`, `partialClose`, `closePosition` are all `async`
- `checkStagedSL` is `async` (returns `Promise<boolean>`)
- `_checkPositionPriceInner` awaits all of them
- `executeTP1Atomic` awaits `partialClose`
- Liquidity rug monitor uses `void this.closePosition(...)` (fire-and-forget)

## P&L calculation (real mode)
- Buy: `sizeSol = result.solSpent` (actual lamports / 1e9)
- Sell: `closePnl = solReceived - costBasis` where `costBasis = sizeSol * fraction`
- No more price-ratio estimate; actual SOL received from Jupiter quote includes slippage
- `tokenAmount` stored in DB (`token_amount DOUBLE PRECISION DEFAULT 0`) for sell sizing

## Config fields replacing virtualBalanceSol
- `slippageBps: number` (default 1000 = 10%)
- `priorityFeeLamports: number` (default 1_000_000 = 0.001 SOL)
- `walletBalanceSol` cached in service class, refreshed via RPC every price loop tick + after each trade

**Why:** virtualBalance was a paper fiction; real balance needs an RPC call and is the source of truth for skip decisions.

**How to apply:** Any future config changes must include slippageBps and priorityFeeLamports; never add virtualBalanceSol back.
