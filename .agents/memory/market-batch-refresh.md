---
name: Market data batch refresh
description: DexScreener refresh was serial (128 tokens × 500ms = 64s/cycle); fixed with batch endpoint (30 mints per request, ~2s total).
---

# Market data batch refresh

## The rule
Never refresh market data with a per-token serial loop when tracking 50+ tokens. Use DexScreener's batch endpoint (`/latest/dex/tokens/MINT1,MINT2,...`) with chunks of 30.

**Why:** 128 tokens × 500ms stagger = 64s per refresh cycle. MARKET_REFRESH_MS was 10s, so the loop took 6× longer than the interval — most tokens got refreshed only once per minute+, showing stale prices.

**How to apply:**
- `fetchTokenPriceBatch(mints[])` returns `Map<mint, DexMarketData>` for a batch of up to 30
- `refreshTrackedTokensMarketData()` chunks all tracked mints into batches of 30, fetches each with a 300ms inter-batch pause
- Broadcast `sniper_status` via WebSocket after EACH batch (not just at the end) for incremental UI updates
- Constants: `MARKET_BATCH_SIZE = 30`, `MARKET_BATCH_PAUSE_MS = 300`, `MARKET_REFRESH_MS = 10_000`

## Pair selection
`pickBestPair(pairs[])` — prefers pumpswap (canonical graduation DEX) regardless of liquidity; falls back to highest-liquidity pair. Use `parseDexPair(best)` to extract `DexMarketData` from a raw DexScreener pair object.

## "X ago" wallet chips ≠ poll staleness
The colored wallet-buy chips at the bottom of token cards show `detectedAt` (when that transaction was first seen). All chips showing "25m ago" just means the token was discovered 25 minutes ago and the baseline scan found those buys at discovery time — NOT that the buy-poll is broken.
