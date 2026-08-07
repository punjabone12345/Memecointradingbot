---
name: Discovery pipeline improvements
description: Suppression model refactor, validation dual-deadline, lifecycle columns, coverage diagnostics endpoint
---

## Suppression model (trenches.service.ts)

`firedAt: Map<mint, number>` replaced with `suppressedUntil: Map<mint, unix-ms>`.
- Normal first fire → `suppressedUntil = now + TRACKING_WINDOW_MS` (1 hour)
- `releaseForRediscovery(mint, delayMs)` export → `suppressedUntil = now + delayMs`
- Sniper engine calls `releaseForRediscovery(mint, TRANSIENT_RETRY_DELAY_MS)` (3 min) on transient validation failures (timeout, no pairs, liq=0)
- Permanent rejections (micro-prune, age-cap) do NOT call releaseForRediscovery — 1-hour window stays

**Why:** Tokens pruned due to DexScreener indexing lag were locked out for 1 hour. By the time rediscovery was allowed, the opportunity was gone. 3-min retry catches slow indexing while not spamming the pipeline.

**How to apply:** Never call `releaseForRediscovery` for micro-prune or age-cap cases. Only for timeout/no-pairs/liq=0.

## validateOrPrune dual deadline (sniper-engine.service.ts)

Two conditions now stop validation, whichever comes first:
1. `VALIDATION_TIMEOUT_MS` = 10 min hard cap from `activatedAt` (was 5 min)
2. `MAX_TOKEN_AGE_FOR_VALIDATION_MS` = 15 min token age via `pairCreatedAt` from DexScreener

New constants: `TRANSIENT_RETRY_DELAY_MS = 3 * 60_000`.

## Lifecycle milestone columns (diag_tokens)

New columns added via migrations:
- `first_dexscreener_pair_at` BIGINT — when validator first got a DexScreener pair
- `first_nonzero_liq_at` BIGINT — when validator first saw liq > 0
- `liq_min_crossed_at` BIGINT — when liq first crossed $500 minimum
- `validation_outcome` TEXT — 'passed' | 'failed_timeout' | 'failed_no_pairs' | 'failed_micro' | 'failed_age_cap'
- `rediscovery_count` INTEGER — how many times released for re-discovery
- `initial_reserve_usd` NUMERIC — reserved/unused column

New write functions in diagnostics.ts:
- `diagTokenValidationMilestone(mint, field, value)` — COALESCE for timestamps, overwrite for outcome
- `diagTokenReleased(mint)` — increments rediscovery_count

## Coverage counters (trenches.service.ts)

New in-memory counters: `totalPoolsSeen`, `totalPoolsFired`, `totalPoolsSkippedAge`, `totalPoolsSkippedDupe`, `totalPoolsSkippedIgnore`.

Exposed via `getTrenchesDiagnostics()` with derived fields: `discoveryRatePct`, `tokensPerHour`, `coverageAlert`, `suppressedCount`.

## New route

`GET /api/diagnostics/coverage` — returns `{ scanner: getTrenchesDiagnostics(), db: getDiagCoverageStats() }`.

`getDiagCoverageStats()` in diagnostics.ts queries lifecycle columns for avg indexing delays and outcome breakdown.

## reserveUsd flow

`releaseForRediscovery` imported directly from `trenches.service.js` into `sniper-engine.service.ts` — no circular dep (trenches only imports from lib/logger and lib/db).

GeckoTerminal `reserve_in_usd` flows: GeckoPool → onGraduation callback `{ reserveUsd }` → `addGraduatedToken(ev.reserveUsd)` → `diagTokenDiscovered({ initialLiquidity: ev.reserveUsd })`.
