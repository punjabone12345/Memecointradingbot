---
name: Sniper entry checklist fields
description: Why entry-decision context (mode/score/price-source/slippage) is persisted on sniper_positions instead of derived after the fact.
---

The sniper entry pipeline (buy detection → consensus/solo scoring → queue → price fetch → position open) computes several values that exist only transiently in memory during that pipeline: which entry mode fired (solo conviction vs multi-wallet consensus), the triggering wallet's score, how many qualifying wallets participated, which price-fetch path succeeded (on-chain vault read / on-chain pool reserves / Jupiter quote), the price at detection vs at fill, and the actual slippage vs the configured max at that moment.

None of this is derivable after the trade closes — the settings that produced it may have since changed, and the in-memory pipeline state is gone. So these are persisted as columns on `sniper_positions` at entry time (not computed retroactively), threaded through the whole call chain: buy handler → `enqueueSignal`/queue → `enterSniperPosition` → DB insert → DB restore-on-restart.

**Why:** the user wants two derived views from this data — (1) a per-trade "why did this fire" checklist in Telegram and the Stats page, and (2) an aggregate breakdown (win rate / avg PnL / total PnL) sliced by entry mode, score bucket, price source, TP tier, and slippage bucket, so tuning decisions ("is consensus mode actually better than solo?") are based on real outcomes rather than guesswork.

**How to apply:** when adding a new entry-time signal that should be analyzable later, add it as a nullable column via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (project's established migration style in `db.ts`), set it inline where the position object is constructed in `enterSniperPosition`, and remember to also read it back in the DB-restore function — otherwise it silently reverts to `undefined` after a server restart.
