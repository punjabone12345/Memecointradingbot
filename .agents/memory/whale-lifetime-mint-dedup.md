---
name: Whale sniper lifetime mint dedup
description: How duplicate re-entries on the same mint were eliminated for the whale sniper module
---

In-memory-only "already traded" tracking (open-positions map, per-token entryTriggered flag) is not durable enough for a "never trade a mint twice, ever" requirement — both reset once a position closes or a tracked token is pruned/re-tracked, so a re-detected graduation event for the same mint could re-enter a trade.

**Why:** the graduation/whale-buy detection pipeline has multiple independent entry points (graduation event handler, tracking activation, signal enqueue, buy-eligibility check, queue processor, final entry function) and re-fires are possible from duplicate on-chain events or re-tracking — any single one of these being unguarded is enough to cause a duplicate trade.

**How to apply:** enforce a lifetime "traded" set backed by a permanent DB table, checked at *every* entry point into the trading pipeline, not just the final buy call. Mark a mint traded immediately on successful entry (not on close), so the guarantee holds regardless of position open/closed state. Load the set from DB at startup. Only clear it (DB + in-memory) as part of an explicit, deliberate "reset all data" admin action — never as a side effect of normal trading/closing logic.
