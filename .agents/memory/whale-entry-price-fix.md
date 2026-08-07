---
name: Whale sniper entry price fix
description: Root cause and fix for whale sniper recording wrong (stale pre-pump) entry prices
---

## The problem
Entry price was consistently showing the pre-whale-pump DexScreener cached price (e.g. $0.000137) instead of the real post-whale pool price ($0.000162). fetchPriceFresh() fell through all sources to DexScreener "last resort" — which caches 30-120s and returns pre-pump values for fresh tokens.

## Root causes
1. **Pool address not yet resolved** when enterWhalePosition runs. enrichTokenMetadataAsync takes 5-15s; the whale can buy within 2-3s of graduation. tok.poolAddress = migration wallet addr (not pool) → fetchOnChainReservePrice fails.
2. **Pre-delay fetchPriceFresh call** (before the 2s wait) ran at the worst moment — zero time for enrichment.
3. **DexScreener last-resort** in fetchPriceFresh returned stale pre-pump price instead of failing clean.

## The fix
1. Remove pre-delay fetchPriceFresh entirely from enterWhalePosition.
2. **Extract vault addresses from whale's tx** in detectBuy() — pool's base vault = target-mint account that DECREASED; pool's quote vault = WSOL account with LARGEST lamport increase (not fee-payer-owned). Store on TrackedToken.
3. **fetchPriceFromVaults(baseVault, quoteVault)** — reads actual pool reserves directly, no pool address resolution needed.
4. **3-path price fetch after 2s delay**: (a) fetchPriceFromVaults from tx vaults, (b) fetchOnChainReservePrice via pool account if enrichment has resolved it, (c) fetchPriceFresh with no pairAddress (Jupiter only).
5. **Removed DexScreener from fetchPriceFresh** permanently — too stale for entry pricing.
6. If all 3 paths return 0 → skip entry, reset entryTriggered=false.

## Why largest-increase for quote vault
The pool's WSOL vault always receives the dominant WSOL increase in a buy tx. First-match with owner filter is fragile because owner field is sometimes absent from getParsedTransaction results, making fee-payer exclusion unreliable.

**Why:** Never fall back to DexScreener priceUsd for entry — it will always be the pre-pump value for fresh tokens.
