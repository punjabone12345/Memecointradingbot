---
name: Whale sniper architecture
description: Whale Sniper module structure, state, and known race-condition class of bugs
---

## Structure
- Completely separate service from the auto-trader / graduation sniper — in-memory state only (`trackedTokens`, `whalePositions`, `buyLog`, `signalQueue`, `closedPositions`), persisted to a `whale_positions` DB table for restart recovery.
- Buy detection via polling `getSignaturesForAddress` per tracked mint, not a push subscription.
- Hooked into graduation detection via a `setOnGraduation` callback registered in the trenches/pumpfun service, not a direct import cycle.

## Overlapping-interval race condition class (fixed)
Two independent `setInterval` loops drove buy polling and position monitoring. `setInterval` does not wait for the previous invocation to finish — if a polling/monitoring sweep takes longer than the interval (common under RPC rate-limiting or many tracked tokens), a new sweep starts while the old one is still running. Two concurrent sweeps can both observe the same un-updated state (e.g. same buy tx not yet marked "seen", same open position not yet closed) and both act on it.

**Why this matters:** this is what caused duplicate Telegram alerts for the same whale buy (same tx entered/alerted twice a few seconds apart) and risked double-closing positions (which would double-credit the paper balance).

**How to apply / general pattern for this codebase:**
1. Prefer self-scheduling `setTimeout` loops (schedule the next run only after the current one resolves) over `setInterval` for any loop that does async I/O — this codebase already had this pattern in `scheduleMarketRefresh`; extend it to any new interval-driven loop.
2. For any operation that must not double-execute for the same key (e.g. entering/closing a position for a given mint) even in the presence of overlapping timers, use a synchronous `Set<string>` lock: check-and-add the lock as the very first synchronous statement (before any `await`) and release it in a `finally`. This closes the race regardless of scheduler overlap, since JS guarantees no other code runs between the check and the add.
3. Remember Replit dev and Render production are separate deployments with separate databases (`DATABASE_URL` is `sync: false` in render.yaml) — bugs reported from production Telegram/UI screenshots cannot be reproduced by inspecting the Replit dev DB/env; you must reason from code alone and confirm the fix compiles/runs cleanly here, then rely on Render redeploy to pick it up.
