---
name: Signal feed race condition & gmgnConfigured gate
description: Why the Smart Wallet Signal Feed showed empty even with active baseline scans; all root causes and fixes.
---

## Fix 1 — Race condition: age-cap prune fires during baseline scan

**The rule:** Add `mintHasActiveBaseline.add(mint)` (with `finally` delete) around the baseline processing loop in `pollTokenBuys`. In `validateOrPrune`, defer the age-cap prune when `mintHasActiveBaseline.has(mint) && tokenAgeMs <= BASELINE_PRUNE_HARD_CAP_MS` (25 min).

**Why:** GMGN 1h-rank tokens are 12–14 min old at activation. `validateOrPrune` prunes them ~2–3 min later (when they cross the 15-min cap). But the baseline scan takes 90+ seconds due to Helius 429 storms. By the time baseline calls `handleVolumeUpdate`, `trackedTokens.get(mint)` returns null → silent early return → nothing in buyLog.

**How to apply:** Any time baseline scan + 429 delays can exceed `MAX_TOKEN_AGE_FOR_VALIDATION_MS - tokenAgeAtActivation`. Currently the guard is in place; don't remove it.

## Fix 2 — Frontend gmgnConfigured gate blocked entry display

**The rule:** The `gmgnConfigured=false` check must show an inline warning banner, NOT replace the buyLog list.

**Why:** Old code gated the entire entry list behind `!gmgnConfigured`. Fixed to show banner inline, always render entries below it.

## Fix 3 — Mobile WS drops large data frames; HTTP poll skips when WS "live"

**The rule:** Always refresh `sniperStatus` via HTTP poll even when WS is connected (every 5s). In `App.tsx` fallback poll `useEffect`, add an `else` branch that calls `api.getSniperStatus().then(setSniperStatus)` when `wsLive`.

**Why:** Mobile WebSocket connections often drop large data frames while keepalive ping/pong still succeeds. The phone shows LIVE (green) but `sniperStatus` stays at the initial state (empty `recentBuyLog`). The fix ensures the signal feed is never more than 5s stale regardless of WS connectivity.

## Fix 4 — Trading window gate silently swallows buyLog entries

**The rule:** In `handleVolumeUpdate`, push a buyLog entry with `skipReason: 'Outside trading window'` BEFORE returning when outside the trading window. Same for settings-unavailable case.

**Why:** The old code called `return` without touching buyLog when `!isInTradingWindow(s)` or when `getSettings()` threw. Users saw "No buyer wallets scored yet" even though transactions were being detected. Now every detected buy appears in the signal feed regardless of trading window state.

## Fix 5 — earlyBuys time window cuts off GMGN historical token buys

**The rule:** Use `earlyBuyFloor = isHistoricalDiscovery ? migrationSec : Math.max(migrationSec, tenMinAgoSec)` instead of always using `Math.max`.

**Why:** For GMGN 1h tokens arriving 43-min-old, `Math.max(migrationSec, tenMinAgoSec)` = `tenMinAgoSec` (10 min) — cutting off all transactions from 10–43 min ago. These older transactions include the early buyers most likely to be smart wallets. With `isHistoricalDiscovery`, we use `migrationSec` to capture all activity since token creation.

## Early exit in baseline batch loop

Add `if (!trackedTokens.has(mint)) break outer;` at top of each batch iteration. Stops wasting Helius calls on tokens pruned mid-scan.
