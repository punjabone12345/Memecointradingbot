---
name: Dip-retrace entry strategy
description: Replaces immediate buy entry; watches each graduated token for 30 min and enters only on 40–60% dump + 60% retrace pattern. Paper mode fires on every Phase 3 trigger.
---

## The Rule
After a token passes the quality gate, do NOT enter immediately. Instead add it to the `dipWatchMap` and check every 5 seconds for a dip-and-retrace pattern. Enter when:
- `dumpPct` (= `(peakHigh - dipLow) / peakHigh * 100`) is between 40–60%
- `retracePct` (= `(currentPrice - dipLow) / (peakHigh - dipLow) * 100`) ≥ 60%

Watch window is 30 minutes (`DIP_WATCH_DURATION_MS`). If no pattern, emit a "skipped/expired" event.

**Why:** The immediate-entry approach chased momentum right at graduation. The dip-retrace pattern buys the "second wave" — after early holders dump and smart money reaccumulates.

**How to apply:** Any time the entry strategy is revisited, the dip-watch parameters (40–60% / 60%) live in the constants `DIP_MIN_PCT`, `DIP_MAX_PCT`, `RETRACE_MIN_PCT` at the top of `graduation-sniper.service.ts`.

## Key design decisions
- `seenMints.add(mint)` happens inside `addToDipWatch`, not `enterPosition` — prevents duplicate watchers.
- `dipWatchIntervalId` runs every 5 s independently of `checkAllPrices` (the position-price loop). This way watchers tick even when there are 0 open positions.
- `DipWatchInternal` extends the public `DipWatchEntry` with private fields (`_quality`, `_signature`, etc.) that are stripped before returning to the API.
- `peakHigh` resets `dipLow` to current price on every new high — this handles pump→dump→pump→dump sequences correctly.

## Paper mode entry (Phase 3)
`enterPhase3Trade()` fires on every Phase 3 trigger (always-on, regardless of wallet). Checks:
1. `openPositions.has(mint)` — skip if already in position
2. `openPositions.size >= maxOpenPositions` — skip if at capacity
3. `virtualBalance < sizeSol` — skip if insufficient paper balance

## TP/SL model (current, as of June 2026)
- **TP1**: +100% → sell 30% → SL moves to breakeven (entryPrice)
- **TP2**: +300% → sell 57% of remaining (≈40% of original) → SL becomes trailing -20% from peak
- **TP3**: +600% → sell 67% of remaining (≈20% of original) → 10% runner stays open
- **Runner**: trailing -10% from peak (trailingStopPct)
- **Initial SL (before TP1)**: FIXED hard -30% from ENTRY price (not trailing, not from peak)
- **After TP1, before TP2**: SL at breakeven (entryPrice) — never goes below entry
- **After TP2**: trailing -slAfterTp2Pct% (default 20%) from trailingHigh, ratchets up
- **After TP3**: trailing -trailingStopPct% (default 10%) from trailingHigh

## DB columns (paper_sniper_positions)
Must have: `tp3_hit BOOLEAN DEFAULT FALSE`, `tp3_realized_sol DOUBLE PRECISION DEFAULT 0`.
Migration adds them with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in index.ts.
persistPosition INSERT includes both columns; rowToPosition reads both columns.

## PaperConfig fields
- `slPhase1Pct` — initial SL % from entry before TP1 (default 30)
- `slAfterTp2Pct` — trailing % from peak after TP2 (default 20) — NEW field
- `trailingStopPct` — runner trailing % from peak after TP3 (default 10)
- `slPhase2Pct`, `slPhase3Pct`, `slAfterTp1Pct` — legacy, no longer used in SL logic
