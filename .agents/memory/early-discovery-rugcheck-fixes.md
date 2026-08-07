---
name: Early Discovery rugcheck filter fixes
description: Root causes of zero trades in early-discovery service and how they were fixed
---

## Problem
EarlyDiscoveryService tracked tokens but never reached ELIGIBLE/ENTERED — 0 trades for hours.

## Root causes & fixes (all applied)

### 1. DexScreener dexId filter excluded "pumpfun"
`fetchDexData` only matched `pumpswap|pump-amm|pump_amm|raydium`. Pre-graduation pump.fun tokens have `dexId="pumpfun"` — all pair data was silently dropped.
**Fix:** Added `"pumpfun"` to the array.

### 2. bondingCurvePct always 0% — Pump.fun Heroku API unreliable
`bondingCurvePct` only came from `fetchPumpFunData` → `client-api-2-74b1891ee9f9.herokuapp.com`. When that fails, curve stays 0% and `minBondingCurvePct=60` blocks everything.
**Fix:** `fetchDexData` now returns `bondingCurvePct` derived from market cap (`mcap / 69000 * 100`). The poll loop takes max of both sources.

### 3. topHolderPct check blocked 100% of brand-new tokens
Bonding curve PDA (per-token keypair, NOT in KNOWN_SAFE_HOLDERS) legitimately holds 100% at launch. Threshold was 60%, then raised to 90% — still blocks 100%.
**Fix:** Removed topHolderPct check entirely. Risk score check (>800) catches genuine rugs.

### 4. "Creator history of rugged tokens" blocked ~70% of tokens
RugCheck flags the entire creator even if prior tokens died naturally. Was a hard DANGER block.
**Fix:** Added to `PUMPFUN_EXPECTED_DANGERS` — downgrades to warning, no hard block.

## What still legitimately blocks
- `rugged: true` flag
- Mint/freeze authority active
- Risk score > 800 (catches coordinated rugs, insider networks, etc.)
- Insider wallet count > 15

**Why:** These are structural properties of the bonding curve mechanism, not malicious acts.
