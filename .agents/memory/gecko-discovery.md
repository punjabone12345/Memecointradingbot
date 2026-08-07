---
name: GeckoTerminal new_pools discovery
description: DexScreener token-profiles/latest/v1 is 429-blocked from Replit's shared IP; replaced with GeckoTerminal new_pools; key quirks for correct operation
---

## Why GeckoTerminal instead of DexScreener

`https://api.dexscreener.com/token-profiles/latest/v1` returns 429 on every poll from Replit's shared IP after the very first request at cold start. Even with User-Agent headers. Switching to `https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=N` resolved this.

**Why:** Replit's shared egress IP is collectively rate-limited by DexScreener's edge at the account/IP level. GeckoTerminal's public API does not have this problem at normal polling rates.

**How to apply:** Always use GeckoTerminal for token-profiles polling from Replit. Do not switch back to DexScreener token-profiles without first testing whether the endpoint returns 200 from Replit's IP.

## Data shape

- Mint: `pool.relationships.base_token.data.id` is `"solana_<MINT>"` — strip `"solana_"` prefix
- Pool address: `pool.id` is `"solana_<POOL_ADDRESS>"` — strip `"solana_"` prefix
- Created at: `pool.attributes.pool_created_at` (ISO string)
- Token name: `pool.attributes.name` formatted as `"TOKEN / SOL"` — split on `" / "` and take index 0

## Rate limit and polling config

- GeckoTerminal free tier: ~30 req/min
- Configured: 2 pages × every 25s = ~5 req/min (safe)
- PAGE_STAGGER_MS = 800ms between pages
- BOOT_DELAY_MS = 8000ms before first poll — prevents 429 from old instance still counted in rate window at restart

## 429 handling

- Exponential backoff: GT_BACKOFF_BASE_MS=15s, GT_BACKOFF_MAX_MS=120s
- On 429: set `gtBackoffUntil`, skip poll entirely until cleared
- `schedulePoll()` uses `max(POLL_INTERVAL_MS, backoffRemaining + 2s)` as delay when in backoff
- Poll success/failure tracking: only marks `lastPollSuccessMs` when at least one page returned 200

## Age filter

- MAX_POOL_AGE_MS = 2 hours — prevents spamming established pools on cold boot
- 1-hour deduplication window per mint — same as MAX_TRACKING_MS in sniper engine
