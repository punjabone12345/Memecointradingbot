---
name: Meteora instruction type filter bug
description: Why extractInstructionType returned wrong values and caused Meteora false positives
---

## The bug

`extractInstructionType(logs)` returns the FIRST "Instruction:" found anywhere in the transaction logs. In a complex Meteora tx (addLiquidity, swap, etc.), SPL Token / System Program runs BEFORE Meteora — so the first "Instruction:" is "InitializeAccount" (creating token accounts for the user's deposit). "InitializeAccount" doesn't match any non-creation keyword, so the event passes the filter as a false positive.

## The fix

`extractMeteoraInstructionType(logs, programId)` scans from the Meteora program's invoke line:
```
Program LBUZKhRxPF3XUpBCjp4YzTKgLLjggiJmzeWAzdm2dvDk invoke [1]
Program log: Instruction: AddLiquidityByStrategy   ← correct
```
It walks forward up to 5 lines from the invoke line to find the next "Instruction:" — which belongs to Meteora, not SPL Token.

## Two-layer filter
1. **Negative**: if Meteora instruction is a known non-creation type (Swap, AddLiq, RemoveLiq, Claim, Position, BinArray…) → skip
2. **Positive**: if Meteora instruction is found but is NOT a known creation type (initialize/create/init) → skip conservatively
3. **Fallback** (invoke not in logs): full-text search for non-creation keywords, then require creation keyword if logs > 5 lines

**Why:** The structural check (preMints) alone is insufficient — addLiquidity creates NEW token accounts when it's the user's first interaction, making it look like pool creation.
