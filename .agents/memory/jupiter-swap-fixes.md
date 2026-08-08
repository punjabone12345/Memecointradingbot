---
name: Jupiter swap Custom:1 / ExceededSlippage fix
description: Root causes and fixes for InstructionError Custom:1 errors on all buy/sell attempts
---

## Root causes of Custom:1 (ExceededSlippage) errors

1. **`slippageBps` + `dynamicSlippage` conflict (original bug)** — passing both caused Jupiter to ignore dynamicSlippage and use the static 1000 bps (10%) floor, which new CPMM pools exceeded constantly.

2. **`dynamicSlippage` alone is WRONG for sniping** — dynamicSlippage simulates at call time and picks a tight value (e.g. 5%). When concurrent bots buy between simulation and our TX landing, that 5% is breached → Custom:1. This was our "fix" that still failed.

3. **CORRECT fix: high fixed `slippageBps` in the swap body (no `dynamicSlippage`)** — `slippageBps: 5000` sets `otherAmountThreshold = quoteOutput * 0.50`. In practice, fills are always much closer to quote price (0.13% impact on a 79 SOL pool). The 50% floor just means bot race conditions can't cause Custom:1.

4. **`skipUserAccountsRpcCalls: true` caused `encoding overruns Uint8Array`** — skips ATA creation for tokens the wallet has never held; Jupiter builds a malformed transaction. Must be removed.

5. **Priority fee too low** — was 50,000 lamports. Raised to 500,000 lamports floor + Helius p75 estimation.

6. **`maxAccounts: 50`** — removed; was forcing bad routes on new pools.

## What getSwapTx does now

```
getSwapTx(quoteResponse, priorityFeeLamports, swapSlippageBps = SWAP_SLIPPAGE_BPS)
```
- `slippageBps: swapSlippageBps` (5000 for normal, 7000 for emergency) — NO `dynamicSlippage`
- NO `skipUserAccountsRpcCalls` — Jupiter creates ATAs as needed
- `wrapAndUnwrapSol: true`, `dynamicComputeUnitLimit: true`
- `prioritizationFeeLamports: <helius p75 or 500k floor>`

## Default config (graduation-sniper.service.ts)

- `slippageBps: 3000` — used only for quote route-finding, widened +1500/retry up to 9000
- `priorityFeeLamports: 500_000` — floor; Helius p75 may raise it at runtime
- `waitBeforeEntryMs: 5000` — gives Jupiter time to index new CPMM pool after graduation

## Helius priority fee estimation (solana-wallet.service.ts)

`getOptimalPriorityFee(defaultLamports, accountKeys?)` — fetches p75 of recent prioritization fees via `getRecentPrioritizationFees`. Caps at 5_000_000 lamports (0.005 SOL). Falls back to `defaultLamports` when HELIUS_API_KEY is absent or call fails.

Called automatically by `buy()` and `sell()` before the retry loop.

**Why:** p75 is aggressive enough to land quickly in congested slots without wasting SOL. The cap prevents runaway fees on extreme congestion events.
