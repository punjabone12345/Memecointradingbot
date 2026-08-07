---
name: Pumpfun Bonding Curve Scanner Fixes
description: Critical bugs found and fixed in pumpfun-trader.service.ts bonding curve scanner using DexScreener
---

## Rule: DexScreener dexId for pump.fun tokens

Pre-graduation pump.fun tokens have `dexId = "pumpfun"` on DexScreener.
Post-graduation tokens (on PumpSwap) have `dexId = "pumpswap"`.
The old `"pump"` dexId does NOT exist — all filters using it return 0 results.

**Why:** DexScreener changed or the assumption was wrong. Verified 2026-06-09 via live API check.

**How to apply:** Any DexScreener filter for pump.fun pre-graduation tokens MUST use `dexId === "pumpfun"`.

## Rule: pump.fun frontend API is Cloudflare-blocked

`https://frontend-api.pump.fun` returns error code 1016 (Cloudflare security block) from server-side requests.
Do NOT use this API. Use DexScreener with `dexId = "pumpfun"` filter instead.

**Why:** Cloudflare protection on pump.fun's frontend API blocks non-browser requests.

## Rule: Raydium SOL/USDC pair address on DexScreener

Use `FHZfpXSzm1XrgUQQs9JrqDT3o4QS4M6ebV2wX2YLtRZ8` for the Raydium SOL/USDC pair.
The old pair address `83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6Q` returns `pairs: null`.
DexScreener endpoint: `GET /latest/dex/pairs/solana/{pairAddress}` — returns `{pairs: [...], pair: ...}`.

**Why:** Raydium migrates liquidity positions; the pair address changes over time.

**How to apply:** If the direct pair lookup returns null, fall back to `search?q=SOL+USDC` and pick the highest-liquidity Solana pair where `baseToken.symbol === "SOL"`.

## Rule: refreshMarketData() outer slice bug

The original code had `Array.from(this.trackedTokens.keys()).slice(0, 30)` BEFORE the batch loop, capping ALL tokens at 30. Fixed to remove the outer slice — only the inner batch slices of 30 remain (for DexScreener's per-request limit).

## Rule: Graduation mcap threshold

`GRADUATION_MCAP_USD = 69_000` is approximately correct. Verified 2026-06-09: highest pumpfun-dex token was $72k mcap; lowest pumpswap-dex token was $548M (graduated token). The graduation boundary is ~$69-80k USD.

## Rule: Near-graduation score boost

Tokens discovered via DexScreener near-grad scan have no PumpPortal trade history so their raw AI score is ~0. Code adds:
- +proximity bonus up to +20 for tokens at 90%+ graduation
- Floors effectiveScore at `minAiScore - 5` for tokens at 95%+ graduation

**Why:** The bonding curve % IS the signal for this strategy — activity score is irrelevant.

## Rule: Default config values for pumpfun trader

- `minAiScore: 55` (lowered from 80)
- `graduationMinPct: 80` (lowered from 85)
These allow near-graduation tokens to qualify for entry even without high on-chain activity.
