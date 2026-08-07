---
name: Old migration trading bugs
description: Root causes of re-trading historical/old pump.fun migrations on server restart + negative price drift
---

## Three root causes found and fixed

### Bug 1 — backfillMissedGraduations fires on initial boot
`backfillMissedGraduations()` was called unconditionally on every `ws.on("open")`, including the very first connect.
On every server restart it fetched the last 25 migration wallet signatures and queued ALL of them — including migrations from hours ago.

**Fix:** Guard with `if (this.wsReconnects > 0)` so backfill only runs on reconnects, not initial boot.

### Bug 2 — backfill did not pre-filter by blockTime
`getSignaturesForAddress` returns `blockTime` for each signature. The loop was ignoring it and calling `processGraduation(sig)` for all 25 sigs, including ones from 50 minutes ago.

**Fix:** Read `blockTime` from each `SigInfo`. If `ageSec > MAX_BACKFILL_AGE_SEC (30s)` → add to `seenSignatures` and skip (no `getTransaction` call). Only null-blockTime or truly fresh sigs (<30s) proceed.

### Bug 3 — vault extraction read bonding-curve vaults instead of new AMM pool vaults
During a PumpSwap migration TX, both the bonding-curve's wSOL vault (pre+post) and the new AMM pool's wSOL vault (post only, newly created) appear in `postTokenBalances`. The old code sorted by highest post-balance and picked the bonding-curve vault, which has a very different SOL/token ratio (~10x inflated price) → caused consistent ~89% negative drift.

**Fix:** In `extractMintFromTx`, build `preWsolIndices` and `preTokenIndices` sets, then prefer accounts NOT in preBalances (newly created = AMM pool vaults). Fall back to highest-post-balance only if no new accounts found.

### Bug 4 — drift guards were one-directional
The paper sniper's exec-delay drift check only aborted on POSITIVE drift (`execDriftPct > maxFillDriftPct`). Negative drift (pool already crashed) slipped through.
Same issue in the live sniper's post-fill circuit breaker.

**Fix:** Added `execDriftPct < -20` abort in `scheduleDelayedEntry` (paper sniper) and extended the live sniper's post-fill check to `entryDriftPct < -MAX_FILL_DRIFT_PCT`.

**Why:** The bonding-curve vault price is ~10x higher than actual AMM pool price for many pump.fun tokens, so detection price >> actual fill price → large negative drift = dead pool signal.

**How to apply:** Any time you add a positive drift guard, also add the symmetric negative guard. Both directions matter for graduated tokens.
