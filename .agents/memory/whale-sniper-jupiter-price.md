---
name: Whale sniper Jupiter price formula
description: How to correctly derive token USD price from a Jupiter quote in the whale sniper — and why swapUsdValue must not be the primary source.
---

## Rule
`price = (0.01 SOL × SOL_USD) / (outAmount / 10^decimals)`

Where:
- `0.01 SOL` = `WSOL_QUOTE_AMOUNT / 1e9` (lamports to SOL)
- `SOL_USD` = `cachedSolPrice` (fetched from Jupiter Price API v2)
- `outAmount` = raw token amount from Jupiter Quote response (`r.data.outAmount`)
- `decimals` = 6 for all pump.fun migrated tokens

## Why NOT swapUsdValue
`swapUsdValue` in the `lite-api.jup.ag/swap/v1/quote` response is `0` or `null` for freshly graduated tokens because Jupiter's price oracle hasn't indexed them yet. When that happened, the old code silently fell back to DexScreener (30–120s stale) and recorded a completely wrong entry price. The `outAmount × SOL_USD` formula bypasses the oracle and reads the actual on-chain reserve ratio — always current.

## SOL/USD price source
Use Jupiter Price API v2 (primary), DexScreener as fallback:
```
GET https://lite-api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112
→ data[WSOL_MINT].price
```
`cachedSolPrice` is initialised to `200` and only updated when fetched price `> 10`, so it never drops to zero.

## How to apply
- `fetchPriceFresh()` calls `fetchSolPrice()` internally — callers don't need a separate pre-call.
- Gate the price math with `outAmount > 0 && cachedSolPrice > 0`.
- `swapUsdValue` is kept as an edge-case fallback if SOL price is somehow unavailable.
- DexScreener is the absolute last resort — always log `source: 'dexscreener-fallback'` as a warning when it's used.
- `priceAtDetection` in `pollTokenBuys` (both baseline and normal paths) must also use `fetchPriceFresh()`, not a raw DexScreener call, so the slippage guard compares two Jupiter prices.
