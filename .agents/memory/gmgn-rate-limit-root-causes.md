---
name: GMGN rate limit root causes
description: Three root causes of recurring GMGN RATE_LIMIT_BANNED bans; all fixed.
---

# GMGN Rate Limit Root Causes (all fixed)

## Root causes

### 1. Startup key burst
All keys start with `lastAt=0` on process startup → fire within milliseconds of each other on the first burst of detected buys → GMGN sees simultaneous requests → bans both keys within seconds of every restart.

**Fix:** `staggerKeyInitialization(keys, INTERVAL_MS)` in `gmgn-limiter.ts`, called from `getKeyStates()` in `gmgn-client.ts`. Key N fires (N × INTERVAL_MS/numKeys) ms after key 0. With 2 keys and 60s interval: key 1 fires immediately, key 2 fires 30s later.

### 2. Warmup period blocks scoring entirely (not just delays it)
`computeScore` checked `getGmgnBannedUntil()` which includes `resumeAfterMs` (post-ban warmup). Result: during warmup, scoring returned `_skippedDueToBan: true` instead of letting `reserveGmgnSlot` naturally delay the request. Scoring was blocked for the full ban + warmup (up to 3 min) instead of just the hard ban window.

**Fix:** `computeScore` now checks `getGmgnHardBannedUntil()` (only `bannedUntilMs`, no warmup). Warmup delays are handled by `reserveGmgnSlot`'s `sleep(resumeAfterMs - now)` internally.

### 3. Silent ban detection failure (`reset_at` as string)
Both `existAuthGet` (gmgn-client.ts) and `applyBanIfPresent` (gmgn-discovery.ts) required `typeof reset_at === 'number'`. If GMGN returns `reset_at` as a numeric string, `applyGmgnBan` was never called → ban undetected → no backoff → same wallets immediately retried → triggered re-ban in a loop with no logging.

**Fix:** Both paths now handle string `reset_at` via `parseInt(rawResetAt, 10)`, and fall back to a 2-minute ban (`now/1000 + 120`) if `reset_at` is missing or unparseable.

## Architecture note
- `getGmgnBannedUntil()` = includes warmup → use for UI display and cache TTL
- `getGmgnHardBannedUntil()` = hard ban only → use in `computeScore` to decide whether to skip GMGN calls entirely
- `getGmgnKeyBannedUntil(key)` = hard ban for one key → used by `pickKeySlot` to avoid selecting a banned key
- `getGmgnAllKeysBannedUntil(keys)` = includes warmup, all keys → underlying function for UI
- `getGmgnAllKeysHardBannedUntil(keys)` = hard ban only, all keys → underlying function for scoring

### 4. Render failover retriggered the shared IP ban
Even after the per-key fixes above, Render could still re-enter `RATE_LIMIT_BANNED`: GMGN's quota is shared by the source IP, so switching from a banned key to another configured key is not safe.

**Fix:** The limiter now applies one global hard-ban and warmup across every GMGN caller and API key. It also recognizes HTTP 429, nested error fields, and millisecond reset timestamps in both wallet scoring and discovery responses.

**Why:** Warmup exists to prevent thundering herd on ban expiry. It should delay requests (via `reserveGmgnSlot`), not block them completely. Making scoring skip entirely during warmup was preventing entries that would have been fine.
