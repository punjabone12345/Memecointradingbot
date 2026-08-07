---
name: Early Discovery bonding curve + trade quality fixes
description: Bonding curve accuracy fixes, duplicate trade guard, entryBondingCurvePct DB field, entryBlockers UI, REST discovery fallback for Replit, name/symbol via DexScreener, on-chain bonding curve reader
---

## Bonding curve was wrong (non-linear with mcap)

**Rule:** Never derive bonding curve % from market cap. `fetchDexData` was using `(mcapUsd / 69000) * 100` which is wildly wrong — a $6.6K mcap token can be at 59.8% curve completion because price acceleration is non-linear.

**Fix:** `fetchDexData` returns `bondingCurvePct: 0` always. The accurate value comes from `fetchBondingCurveOnChain` which reads `realSolReserves` at byte offset 32 (u64 LE) of the bonding curve PDA account. Formula: `realSolReserves / 85_000_000_000n * 100`. `complete` bool at byte 48 = 100%.

## On-chain bonding curve reader (no API key needed)

PDA derivation: SHA256(b"bonding-curve" || mintBytes || nonce || programIdBytes || b"ProgramDerivedAddress"), nonce 255→0, pick first hash NOT on Ed25519 curve.

Implemented as `computeBondingCurvePda(mint)` + `fetchBondingCurveOnChain(mint)` in `early-discovery.service.ts`. Uses Helius RPC if `HELIUS_API_KEY` is set, otherwise falls back to public Solana RPC. Called in both `onNewLaunchWithMeta` (initial check) and `pollToken` (every 30s refresh).

## Dead pump.fun APIs — use DexScreener + on-chain instead

**Rule:** Both pump.fun REST APIs are unreachable from Replit:
- `client-api-2-74b1891ee9f9.herokuapp.com` → dead Heroku app
- `frontend-api.pump.fun` → Cloudflare 1016 error

`fetchPumpFunData` will always return `null` from Replit. `fetchDexData` (`api.dexscreener.com/tokens/v1/solana/{mint}`) is the reliable fallback — it returns `baseToken.symbol`, `baseToken.name`, `dexId`, `priceUsd`, `marketCap`, `pairCreatedAt`.

**Fix in `fetchDexData`**: Return type extended to include `symbol`, `name`, `dexId`, `pairCreatedAt`. Prefers `dexId === "pumpfun"` pair over graduated dexes.

**Fix in `onNewLaunchWithMeta`**: Call `fetchDexData` concurrently alongside `fetchPumpFunData` + `runRugcheck`. Use dex symbol/name when pfData is null. After on-chain bonding curve check, reject if no bonding curve account AND dexId !== "pumpfun".

**Fix in `pollToken`**: Same dex name/symbol fallback. Call `fetchBondingCurveOnChain` on every poll cycle. Reject token if on-chain returns null and pfData was also null (no bonding curve = graduated).

## Graduated token rejection

**Rule:** Reject any token where DexScreener pair shows `dexId !== "pumpfun"`. These are on Raydium/PumpSwap — already graduated, not pre-migration candidates.

Log message: `"Early discovery: rejected — already graduated ⛔"` with `dexId` field.

## In-flight duplicate trade guard

**Rule:** Before entering a paper trade, check `enteringMints.has(mint)` AND `openPositions.has(mint)`. Add to `enteringMints` at the start; delete from it at every early return AND at successful entry.

## REST discovery fallback — critical for Replit

**Rule:** PumpPortal WS is ECONNREFUSED from Replit's network. Two parallel REST discovery sources run always-on (at startup + every 30s):

1. **Solana public RPC** (`getSignaturesForAddress` for pump.fun program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`):
   - First poll: seed `lastRpcSignature` cursor, don't process old txs
   - Subsequent polls: fetch up to 5 new successful txs, call `getTransaction` to extract mint from "Instruction: Create" logs
   - Fallback: scan `accountKeys` for address ending in "pump"
   
2. **DexScreener `/token-profiles/latest/v1`**:
   - Filter: `chainId === "solana"` AND `tokenAddress.endsWith("pump")` AND `updatedAt` within last 90 minutes
   - 90-min freshness filter is critical — older profiles are almost always graduated tokens

**Dead endpoints (do NOT use from Replit):**
- `client-api-2-74b1891ee9f9.herokuapp.com` — Heroku "no such app" (dead)
- `frontend-api.pump.fun` — Cloudflare 1016 error (blocks Replit IPs)
- Birdeye public API — requires API key

`connectionSource` now reports `"polling"` when both WebSockets are down. Frontend shows "POLLING" badge.

## entryBondingCurvePct field

Added to `EDPosition` interface, DB (`entry_bonding_curve_pct DOUBLE PRECISION DEFAULT 0` + `ALTER TABLE IF NOT EXISTS` migration), `persistPosition` SQL (30 params), `loadPositions` mapping.

## entryBlockers surfaced in UI

`checkEntryConditions` returns `blockers: string[]`. Stored on `token.entryBlockers` and sent to frontend. The `EntryChecklist` component shows green ✓ / red ✗ for all entry conditions live.
