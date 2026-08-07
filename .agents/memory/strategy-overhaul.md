---
name: Strategy overhaul — quality filter + 4-stage TP/SL
description: Complete trading strategy redesign: quality scoring gate, 10s candle entry, 4-stage TP/SL with variable position sizing
---

## Overview
Full strategy redesign replacing old 2-stage TP with quality-gated 4-stage system.

## Key design decisions

### Quality collection (60 s parallel)
- token-quality.service.ts collects 4 dimensions in parallel: liquidity (DexScreener), buy pressure (DexScreener m5 txns), unique buyers (Helius transfers), top-holder concentration (Helius token accounts)
- Scored 0-100 (25 pts each); minQualityScore default = 70 → tokens below this are skipped, event recorded with skipReason
- Whale threshold: topHolderPct > 15% → whaleDetected = true; penalizes score by 15 pts

### Candle entry (10 s)
- buildCandle() polls on-chain reserves every 3 s for `windowMs` (default 10 000 ms)
- Falls back to DexScreener if vault pubkeys unavailable
- Entry fires only if candle.isGreen AND candle.isActive (buys > 0 in window)
- Non-green or inactive candles abort entry

### 4-stage TP/SL
- SL: hard -12% (pre-TP1 only); after TP1 hit, trailing-stop takes over
- TP1: +100%, close 30% → trailing stop activates at -15% from high
- TP2: +300%, close 30% → trailing tightens to -10%
- TP3: +600%, close 20% → trailing tightens to -10% (runner 20% rides)
- All stages stored as tp1Hit/tp2Hit/tp3Hit booleans in DB

### Variable position sizing
- quality ≥ 90 → 1.5× base size
- quality ≥ 80 → 1.25×
- quality ≥ 70 → 1.0×
- Below 70 → skip (not entered)

### DB columns added (in index.ts migration)
`tp3_hit`, `tp3_realized_sol`, `quality_score`, `liquidity_sol`, `buy_pressure_ratio`, `unique_buyers`, `top_holder_pct`, `whale_detected`, `position_multiplier`

### WsMessage type
Added `"paper_sniper_update"` to the union — required for paper-sniper route WebSocket broadcast.

**Why:** The old 2-stage TP exited too early on meme runners; quality filter prevents entering low-conviction tokens.

**How to apply:** DEFAULT_CONFIG in graduation-sniper.service.ts is the source of truth for all thresholds. If adjusting TP levels, update both _checkPositionPriceInner and the ticker display in GraduationSniper.tsx header.
