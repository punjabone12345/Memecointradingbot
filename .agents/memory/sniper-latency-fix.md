---
name: Sniper entry pipeline latency fix
description: Root causes of 40s detection-to-execution latency and how they were fixed
---

The full entry pipeline (graduation WS event → position recorded) was taking 40s. Expected: ~7-8s.

## Root Causes

### 1. extractMintFromTx delays too conservative
Old: `[0, 1_000, 3_000, 5_000, 8_000]` ms — up to 17s cumulative.
Helius REST indexes the TX within ~1s of WS event delivery. Old delays were designed for a slow fallback path.
Fix: `[0, 400, 800, 1_500, 2_500]` — worst case 5.2s.

### 2. Post-buy price resolution blocked enterPosition for 2–15s
Old order (all blocking):
  - P1: `fetchActualBuyAmounts` — hardcoded 2s sleep + HTTP request (~3s)
  - P2: `fetchSolUsdPrice` + Jupiter quote math (~1s) — only ran if P1 failed
  - P3: DexScreener retries 5×3s = 15s — only ran if P1+P2 both failed
  Position was only recorded AFTER all of this, so Telegram + dashboard update delayed by 3–18s after buy TX.

Fix: Promoted P2 (Jupiter quote + SOL/USD) to run FIRST — it only needs fetchSolUsdPrice (~0.5-1s) and values already returned by the confirmed swap (sizeSol, tokenAmount). No sleep required.
Position is recorded immediately after P2. P1 and P3 run in a new `refineEntryPriceInBackground()` method (fire-and-forget void) and update entryPrice/tokenAmount/SL silently after the fact.

## How to apply
- Never add blocking awaits between `buy()` return and `this.openPositions.set(mint, pos)`.
- Any price accuracy improvement that requires network I/O after the buy belongs in `refineEntryPriceInBackground`.
- `extractMintFromTx` delays should stay tight (≤3s total) — Helius WS + REST are co-located.

**Why:** The 40s latency was causing the bot to miss the early price action after graduation. Most of the delay was pure waiting with no trading benefit.
