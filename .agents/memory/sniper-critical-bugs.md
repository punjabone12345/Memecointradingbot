---
name: Critical sniper bugs fixed
description: Three silent bugs that caused positions to never close and wrong entry prices — must never be reintroduced
---

## Bug 1 — isDuplicateTrade permanently blocks all closes (WORST BUG)

**Symptom:** Auto-SL never fires; manual "close" button shows toast "Position closed at market price" but position stays open forever.

**Root cause:** `closePosition()` checked `isDuplicateTrade(pos)` as its FIRST guard. The fingerprint (`mint:entryMinute`) is saved to `data/closed_trades.json` when a close is attempted. If the server restarts after the fingerprint is saved but before the DB status is updated to "closed", the position reloads as "open" but `isDuplicateTrade` returns true and silently blocks every future close — including manual closes. `manualClosePosition` still returns `{ ...pos }` so the API returns success and the frontend shows the toast.

**Fix:** Removed `isDuplicateTrade` check from `closePosition` entirely. Fingerprint is still registered AFTER a confirmed sell (inside `registerClosedTrade`) to prevent double-recording in history. A position in `openPositions` must ALWAYS be closeable regardless of fingerprint state.

**Why:** The guard was designed to prevent duplicate history entries after restart, but it incorrectly blocked the actual sell transaction — not just the recording.

---

## Bug 2 — trailingHigh=0 makes dropFromPeak always 0%, SL never fires

**Symptom:** Phase-2/3 SL (e.g. -40%) never triggers even when price is well below threshold.

**Root cause:** `rowToPosition()` loaded `trailingHigh` from DB as `Number(row["trailing_high"] ?? 0)`. If `trailing_high` column was NULL, `trailingHigh = 0`. On the first price tick, line `if (price > pos.trailingHigh) pos.trailingHigh = price` fires because `price > 0` is always true — setting `trailingHigh` to the CURRENT (already crashed) price. Then `dropFromPeak = (1 - price/price) * 100 = 0%` forever.

**Fix (3 layers):**
1. DB load: `Number(row["trailing_high"]) || Number(row["entry_price"]) || 0` — uses entryPrice as fallback
2. Runtime correction pass after load: loops all open positions, sets `trailingHigh = entryPrice` if below
3. `checkStagedSL`: uses `Math.max(trailingHigh, entryPrice)` as peak floor — entryPrice can never be less than the SL reference

---

## Bug 3 — Entry price uses pre-buy detection price when all fallbacks fail

**Symptom:** App shows 19k mcap, GMGN shows 48k mcap. App shows +150% profit, actual is 0%.

**Root cause:** Entry price has 3 fallbacks. When a token pumps 2.5x during buy execution:
1. Helius TX parsing → fails if `HELIUS_API_KEY` not set (returns null immediately)
2. DexScreener post-buy → fails because new graduation pairs take ~15-60s to appear
3. Falls back to `price` — the pre-buy detection price, which is 2.5x lower than actual fill

**Fix:** Added Priority 2 between Helius and DexScreener: compute price from Jupiter's own quote data (`sizeSol × solUsdPrice / (tokenAmount / 10^6)`). This is always available since it comes directly from the buy result. Also:
- Fixed DexScreener fallback to retry 5× with 3s gap (handles new pair indexing lag)
- Fixed `tokensReceivedUi` null handling in Helius parser (compute from `amount / 10^decimals`)
- Added explicit warning log when all methods fail and pre-buy price is used

**How to apply:** Never add a pre-buy price as the only fallback for entry price. Always include a Jupiter-quote-based calculation as a no-external-API fallback.
