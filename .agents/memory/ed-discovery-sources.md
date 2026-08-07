---
name: ED token discovery sources
description: What APIs work for discovering new pump.fun token launches in Replit and calibration rules for rugcheck on brand-new tokens
---

## What WORKS in Replit

### PumpPortal WS — CONFIRMED WORKING on Replit (as of June 2026)
- `wss://pumpportal.fun/api/data` — previously thought to be ECONNREFUSED on Replit, but confirmed connected in live test.
- Subscribe: `{ method: "subscribeNewToken" }` and `{ method: "subscribeTokenTrade" }`
- Events have `mint` or `tokenAddress` field with the Solana mint address
- Reconnects automatically every 15s on close
- Implemented in scanner.service.ts as `startNewTokenStream()` — called from `startAutoTrader()`

### GeckoTerminal new_pools
- `https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1..10`
- 10 pages × ~20 pools = ~200 newest pools, sorted newest-first
- Includes `relationships.base_token.data.id` = `"solana_<MINT>"` for extracting mint address
- **Rate limit (CRITICAL)**: free tier allows ~30 req/min; firing all 20 endpoints (5 trending + 5 volume + 10 new_pools) simultaneously causes instant 429 on ALL of them.
  - Fix: stagger in groups of 4 with 500ms delay between groups
  - Fix: cache results for 60s (`geckoCachedMints`/`geckoCacheTs`/`GECKO_CACHE_TTL_MS=60000`); return cache on hit; return stale cache on error
  - After startup burst, rate-limiting clears and GeckoTerminal starts returning ~80-200 mints/min

### Orca whirlpool discovery
- `https://api.mainnet.orca.so/v1/whirlpool/list` — returns ~18MB, ~9,854 unique token mints
- Cache for 5 min (`orcaMintCache`/`orcaCacheTs`/`ORCA_CACHE_TTL_MS=5min`)
- Rotate a 1000-mint window each cycle using `orcaCursor` module-level variable (advances by `ORCA_WINDOW=1000`)
- Hard cap of `MAX_MINTS_PER_SCAN=3000` across all sources combined

### Raydium double-sort
- Fetch both `volume24h` DESC and `fee24h` DESC from Raydium on-chain API → ~2×992 mints, deduped

### ageBannedMints effectiveness
- After ~10 scan cycles: ~1500+ tokens permanently banned (old established Raydium/Orca pools)
- Frees scan slots for fresh tokens from PumpPortal WS and GeckoTerminal new_pools
- scanCount stabilizes around 400-600 fresh tokens after ~5 min of warm-up

## What is blocked in Replit's sandbox
- `https://client-api-2-74b1891ee9f9.herokuapp.com` — dead Heroku app ("No such app").
- `https://frontend-api.pump.fun` — Cloudflare error 1016 (blocked).
- `https://frontend-api-v3.pump.fun` — metadata only, not for discovery.

## Age-banned mints pattern
- `ageBannedMints = new Set<string>()` in scanner.service.ts — permanently stores mints exceeding maxAgeHours
- When a token crosses maxAgeHours in pre-filter OR hot-refresh: add to ageBanned, delete from tokenCache and liquidityHistory
- freshMintQueue mints are also cleaned when age-banned
- In fetchDexPairs: ageBanned mints are removed from extraMints before batch lookup (saves API calls)
- Exposed via getScanStats() as `ageBanned` and `freshQueueSize` and `pumpPortalConnected`

## Rugcheck calibration for new tokens
- When `pairAgeMinutes < 15`, skip these danger risks (normal at launch — dev holds all supply):
  - `"Single holder ownership"`
  - `"Top 10 holders high ownership"`
- Also skip `topHolderPct > 40` check for very new tokens.
- Still block on: `rugged` flag, mint authority, freeze authority, other DANGER risks (creator rug history, large LP unlocked), score > 800.

**Why:** A pump.fun token at launch always has 100% held by deployer. RugCheck marks this as DANGER. Without this filter, every single new token gets rejected immediately.
