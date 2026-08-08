---
name: Pumpfun Pre-Grad vs Graduation Sniper separation
description: Architectural rules for keeping Module A (pump.fun pre-grad) and Module B (graduation sniper) strictly separate
---

## Rule
Module A (pump.fun pre-graduation) and Module B (graduation sniper) are completely separate trading systems with different TP structures. Never merge or share TP/SL logic between them.

**Why:** User specified this explicitly. Cross-contamination of TP logic would silently break the strategy of whichever module gets the wrong settings.

## Module A — Pre-Graduation (pumpfun-trader.service.ts, /api/pumpfun/*, PumpfunTrader.tsx)
- Entry: AI score ≥ 80, graduation 85–99.5%, no anti-rug triggers
- TP1: +300% → sell 25%
- TP2: +1000% → sell 25%
- Moonbag: 50% remaining, trailing stop 40% below peak (activates AFTER TP2 only)
- SL: -40%; early exit -30% in first 60s

## Module B — Post-Graduation Sniper (graduation-sniper.service.ts, /api/sniper/*, GraduationSniper.tsx)
- Entry: token graduates from pump.fun (mcap ~$69k), wait then buy
- TP1: +150% → sell 40%
- TP2: +400% → sell 40%
- Runner: 20% remaining, trailing 30% below peak
- SL: -40%

## How to apply
Before editing any TP/SL logic, check which service file you're in. If touching pumpfun-trader.service.ts, use Module A constants. If touching graduation-sniper.service.ts, use Module B constants.

## DB tables
- Module A: `pumpfun_positions`, `kv_store` (key: "pumpfun_config")
- Module B: `sniper_positions`, `kv_store` (key: "sniper_config")

## Navigation
- Scanner tab → renamed "Pump.fun" → route /scanner → PumpfunTrader.tsx (Module A)
- Sniper tab → route /sniper → GraduationSniper.tsx (Module B) — DO NOT MODIFY
