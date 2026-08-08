---
name: Migration-discovery blackout during Helius rate-limit episodes
description: Why the graduation scanner could go dark for many minutes then burst-catch-up, and the fallback-to-public-RPC fix.
---

## Symptom
User (running on Render) reported no trades for ~4 hours, with the dashboard's
"last transaction" timestamp stuck ~27 minutes old, then suddenly 20-30
transactions processed within 10 seconds. This is NOT a process crash/restart
(a restart resets the migration cursor via `isBootstrap` and would never
burst-replay old transactions) — it's the scanner itself going idle, then
catching up its backlog via the `until: lastSeenSig` cursor in one poll tick.

## Root cause
`trenches.service.ts`'s `trackMigrationWallet()` (the ONLY source of new
token/graduation discovery — the sniper's entry pipeline has nothing to act on
without it) had `if (isHeliusCoolingDown()) return;` at the top of every poll
cycle. The shared Helius limiter's global cooldown (`helius-limiter.ts`) is
capped at 120s per occurrence, but if Helius keeps 429ing on each retry (quota
exhaustion / sustained rate limiting from other services sharing the same
key), the cooldown renews every ~120s indefinitely — and this early return
meant the scanner didn't even attempt the public-RPC fallback that already
existed inside `rpcGetSignatures()` for exactly this scenario. Compounded with
the Helius WS reconnect backoff (previously capped at 5 min on 429), a
sustained rate-limit episode could plausibly blank the feed for the ~27
minutes reported.

## Fix
- `trackMigrationWallet()` and the WS-triggered `processMigrationSig()` in
  `trenches.service.ts` now check `isHeliusCoolingDown()` and, if true, call
  the public Solana RPC directly (bypassing `withHeliusLimit` and the Helius
  endpoint entirely) instead of skipping the cycle. Discovery keeps running on
  public RPC throughout a Helius outage; it switches back once the cooldown
  clears.
- WS reconnect backoff cap (`helius-ws-shared.ts`) reduced from 5 min to 2 min
  to match the poll fallback's recovery cadence.
- Added a zombie-connection watchdog to the shared Helius WS: a `ws.ping()` +
  pong-deadline (45s) forces `ws.terminate()` (triggering the normal reconnect
  path) if the socket goes silent without ever firing a `close` event — a
  known failure mode on some host/proxy combinations (seen flagged for Render)
  where an idle TCP connection is dropped without a FIN/RST.
- `/api/debug` now exposes `heliusCooldown: { active, remainingMs }` for fast
  diagnosis of this exact scenario in the future.

## How to apply
Any new Helius-backed polling loop that is a single point of failure for
discovery (i.e., nothing else feeds the pipeline if it stops) must not have a
bare `if (isHeliusCoolingDown()) return`/skip with no public-RPC fallback —
either fall back like this fix does, or accept that the entire feature goes
dark for the duration of every cooldown, which compounds under sustained
rate-limiting far beyond the single-cooldown cap.

**Why:** the user's requirement is trades must never silently stop for
extended periods; a bare skip during cooldown directly violated that, even
though each individual line of backoff logic looked reasonable in isolation.
