---
name: AMM pool gate — Jupiter quote replaces DexScreener
description: The graduation gate uses Jupiter quote check (not DexScreener) to verify a migrated token is tradeable.
---

## The rule

**Use Jupiter quote check as the AMM pool gate, not DexScreener.**

DexScreener is fundamentally the wrong tool for newly-graduated tokens:
1. It lags 30–120 s after migration before indexing the new PumpSwap pool
2. It KEEPS showing the old `pumpfun` bonding-curve pair indefinitely — so you can NEVER distinguish "token hasn't migrated" from "indexing lag" using DexScreener alone
3. Confirmed live: FLAMY showed only `dexId:"pumpfun"` on DexScreener even after full migration, while Jupiter returned `routePlan: ['Pump.fun Amm']` and `outAmount: 39564462801`

Jupiter is the correct gate because:
- It indexes PumpSwap pools within ~5–15 s of creation (much faster than DexScreener)
- It directly validates the actual trading path — if Jupiter can quote, the swap will succeed
- It's the engine we use for the actual buy anyway

## How it works (both services)

```
Gate: GET https://lite-api.jup.ag/swap/v1/quote
      ?inputMint=So11...112&outputMint={mint}&amount=10000000&slippageBps=5000

  outAmount > 0  → pool is live, proceed immediately ✅
  error/no route → keep retrying
  After 10 × 4s = 40s, still no route → block ❌ (genuine false trigger)
```

## Paper sniper price (Step 2, after Jupiter gate passes)

Jupiter confirmed tradability. Now get USD price:
1. Try DexScreener 5 × 3s — prefer AMM pair (`pumpswap`/`raydium`), accept any pair (bonding-curve price ≈ AMM price at launch)
2. Fallback: calculate from Jupiter quote → `execPrice = (0.01 SOL × solUsdPrice) / jupiterOutAmount`

**Why:** By the time Jupiter confirms (5–15s), DexScreener often still only has the bonding-curve pair. The bonding-curve `priceUsd` is valid and close to the AMM launch price, so it's an acceptable price source.

## Applied in

- `graduation-sniper.service.ts` — `processGraduation()`, `!wsolVaultPubkey` branch (~line 1178)
- `paper-sniper.service.ts` — `scheduleDelayedEntry()` Step 1 gate + Step 2 price (~line 376)
- The `hasRaydiumPool()` helper in graduation-sniper (separate code path) still uses DexScreener for ongoing position checks — that's fine since it's not time-sensitive

## History of failed approaches

1. Required `dexId === "raydium"` only → missed PumpSwap (Pump.fun migrated away from Raydium)
2. Accepted pumpswap but early-exited on "pumpfun-only" → blocked real graduations (old pair lingers)
3. Removed early-exit, 75s window → STILL blocked (DexScreener NEVER shows pumpswap for some tokens)
4. ✅ **Jupiter quote check** — correct and fast
