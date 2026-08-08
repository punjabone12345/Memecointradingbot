---
name: Graduation detection architecture
description: How pump.fun graduation events are detected — single migration wallet subscription only; why subs 2 & 3 were removed.
---

## Rule
Only ONE WebSocket subscription is used for graduation detection: `logsSubscribe` on the migration wallet `39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg`.

Do NOT add subscriptions for PUMPFUN_PROGRAM_ID or PUMPSWAP_PROGRAM_ID.

**Why:** The pump.fun program sub fired ~1000+ buy/sell TXes per minute — even with "migrate instruction" log-filtering it let through ~49 false grad events per real one. The PumpSwap AMM sub fired for tokens that were never on pump.fun (launched directly on PumpSwap) and for already-migrated tokens being traded. These produced false "Today's Grads" counts and caused the bot to attempt trading random non-graduation tokens. The migration wallet `39azUY…` is a DEDICATED graduation signer — it appears in EVERY pump.fun graduation TX and in NO other TX type.

**How to apply:** If coverage is ever missing, fix the backfill (`getSignaturesForAddress(MIGRATION_WALLET)`) not the subscriptions. Adding sub 2 or sub 3 back would immediately reintroduce mass false positives.

## Defence-in-depth inside extractMintFromTx
Even though sub 1 is already authoritative, `extractMintFromTx` also validates:
1. MIGRATION_WALLET appears in TX `accountKeys` → pump.fun graduation confirmed
2. OR TX `meta.logMessages` contains "instruction: migrate" / "migrate_v2" / "migratev2" → also confirmed

If neither passes → return null immediately (no retry), no trade entered.

## Today's Grads counter
`graduationsToday` is incremented at line ~1159 inside `processGraduation`, AFTER `extractMintFromTx` returns non-null AND after the mint-level dedup guard. So the counter reflects genuine confirmed graduations only.
