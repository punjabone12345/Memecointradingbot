---
name: Balance mutation atomicity
description: Why all SOL balance changes in the trading bot must go through adjustBalance(), not getBalance()+setBalance()
---

Any code that changes `currentBalanceSol` must use `adjustBalance(deltaSol)` in `settings.service.ts`, never a manual `getBalance()` → compute → `setBalance()` sequence.

**Why:** Multiple independent modules (auto-trader position open/close, whale-sniper entries/partial-TP/close/delete) update the same balance concurrently. A plain read-modify-write is a classic race: two concurrent updates can both read the same starting value, and the second write clobbers the first, silently dropping a trade's effect on the tracked balance. This caused balance/analytics to drift from what Telegram confirmed was actually traded.

**How to apply:** `adjustBalance()` serializes all balance updates through an in-process promise-chain mutex and always re-reads the DB value at execution time (bypassing the stale in-memory cache), so concurrent callers stack correctly instead of overwriting each other. When adding any new feature that changes balance, call `adjustBalance()` — do not reintroduce `getBalance()+setBalance()` pairs.
