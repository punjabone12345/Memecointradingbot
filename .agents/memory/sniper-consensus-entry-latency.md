---
name: Smart Wallet Consensus entry latency fix
description: Why entries under the GMGN wallet-consensus strategy took 30-40s and how they were cut toward ~3-4s.
---

## Root causes found (current architecture: sniper-engine.service.ts + wallet-consensus.service.ts, NOT the older "sniper"/"whale" modules referenced elsewhere in memory)

1. **`fetchTokenPrice(mint)` (DexScreener, 6s timeout) was awaited at the very
   top of `enterSniperPosition`**, purely to enrich display name/symbol/mcap/
   liquidity. This blocked the ENTIRE entry pipeline before the real price
   fetch or the buy even started. Fixed: deferred to a fire-and-forget
   `refineEntryMetadataInBackground()` that patches the position/tracked-token
   record after entry already happened.
2. **`ENTRY_DELAY_MS` was a flat 2000ms wait** before every entry, added when
   the strategy still needed Jupiter/pool-address resolution time. It's no
   longer needed for the primary price path (`fetchPriceFromVaults`) because
   vault addresses are captured directly from the buyer's tx at detection
   time — ground truth, zero indexer lag. Reduced to 400ms buffer only.
3. **All Helius RPC calls (buy-detection tx fetches, entry price vault reads,
   AND routine background polling/enrichment/market-refresh) shared one FIFO
   queue** in `helius-limiter.ts` (`MAX_CONCURRENT` slots). Under load, an
   entry-critical price read could queue behind unrelated background sweeps.
   Fixed: added a two-lane priority queue — `withHeliusLimit(fn, { priority: true })`
   for buy-detection (WS-triggered `pollTokenBuys`) and entry price reads
   (`fetchPriceFromVaults`/`fetchOnChainReservePrice` inside `enterSniperPosition`)
   always drains ahead of normal-priority background calls when a concurrency
   slot frees up. Total request budget (RPS/concurrency/cooldown) is unchanged —
   this only reorders, it never bypasses Helius rate limits.

## How to apply
- Any NEW blocking `await` added between buy detection and `openPositions.set(mint, pos)`
  in `enterSniperPosition` re-introduces this latency class. Cosmetic/display-only
  data (name, symbol, mcap, liquidity beyond the SL/TP-critical fields) belongs in
  a background refine step, never inline before entry.
- Any new Helius RPC call that is on the entry-critical path should pass
  `{ priority: true }` to `withHeliusLimit`. Routine housekeeping (market refresh,
  pool enrichment, validation sweeps) should stay at default (normal) priority.
- Wallet-score GMGN lookups (`wallet-score.service.ts`) still cap at 3.5s
  (`LOOKUP_TIMEOUT_MS`) per uncached wallet — this is a legitimate cost of the
  scoring strategy, not a bug, and was left untouched to avoid degrading score
  quality (lowering it further would mean more wallets fall back to a 0 score,
  i.e. fewer real entries, not fewer skipped transactions).
- This project's live-trading secrets (`SOLANA_PRIVATE_KEY`, `HELIUS_API_KEY`,
  `GMGN_API_KEY`, Telegram) live on Render, not Replit — the latency fix can be
  verified for compile/boot in Replit's paper-trading mode, but real-world timing
  can only be confirmed after deploying to Render (via `push.sh` → GitHub → Render
  auto-deploy).

**Why:** the user reported real entries landing 30-40s after the qualifying buy
was detected, with a 3-4s target and a hard requirement that no qualifying
transaction be skipped (so timeouts/thresholds were left alone; only reordering
and removing genuinely unnecessary blocking waits were used as the fix).
