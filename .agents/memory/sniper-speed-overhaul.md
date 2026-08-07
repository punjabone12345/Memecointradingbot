---
name: Sniper speed overhaul
description: On-chain price pipeline that replaces DexScreener for entry — cuts ~90s latency to ~2.5s
---

## The problem
Two root causes of ~90s entry latency:
1. `extractMintFromTx` called Helius Enhanced API first (1-5s extra Helius indexing delay) before falling back to `getTransaction`
2. `fetchPriceFast` (and pool gate) waited on DexScreener which has 30-120s indexing lag for newly-graduated tokens

## The fix: on-chain-first pipeline

### extractMintFromTx changes
- Removed Enhanced API entirely — it requires EXTRA Helius indexing time (1-5s), making it SLOWER than direct `getTransaction`
- The WebSocket fires at "confirmed" commitment, so the TX is already indexed when we call `getTransaction` → attempt 0 succeeds immediately
- Tightened retry delays: `[0, 300, 600, 1200]` (was `[0, 400, 800, 1500, 2500]`)
- Now also extracts `tokenVaultPubkey` (highest-balance non-SOL account in postTokenBalances)
- Return type: `{ mint, wsolVaultPubkey, tokenVaultPubkey }`

### New fetchOnChainPoolReserves method
- Calls `getTokenAccountBalance` for BOTH vaults simultaneously (parallel axios.post)
- Returns `{ solBalance, tokenBalanceRaw, tokenBalanceUi }` in ~200ms
- Price = `(solBalance / tokenBalanceUi) * solUsdPrice` = pool reserve ratio formula
- Zero indexer lag — vault accounts created by the migration TX itself

### processGraduation T0-T2 pipeline
- T0: fire all simultaneously: `reservesPromise`, `solUsdPromise`, `preQuotePromise`, `dexPricePromise` (background), `rugTimerPromise` (1.5s)
- T1 (~200-400ms): on-chain price computed; pool SOL validated from `reserves.solBalance` (no extra RPC)
- Pool gate SKIPPED when `onChainPriceValid === true` (vaults confirm pool existence on-chain, zero DexScreener lag)
- DexScreener: 200ms non-blocking race for symbol/name only; temp `mint.slice(0,8)` if not indexed
- T2 (1.5s): rug check via second `fetchOnChainPoolReserves` call (no DexScreener needed)
- DexScreener fallback: only used if on-chain rug read fails (unlikely)

## Timing budget
- T0: mint + vault addresses known (from WS event + getTransaction)
- T0→T1: ~200-400ms (parallel vault reads)
- T1→T2: 1.5s (rug timer, already running from T0)
- T2→buy: ~400-600ms (rug reserves re-read + Jupiter quote from prefetch)
- **Total: ~2.5s from detection** (vs ~90s before)

## What DexScreener is still used for
- Ongoing position price monitoring (price loop) — it has data by then (position is open)
- Symbol/name background fetch after entry (updates display)
- Fallback gate only if `extractMintFromTx` fails to return vault pubkeys (rare)

**Why:** DexScreener 30-120s indexing lag was the primary bottleneck. On-chain vault accounts exist from block 0 of the migration TX — price computable immediately from reserve ratio. Enhanced API was counterintuitively SLOWER because Helius must parse and index before responding.
