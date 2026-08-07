---
name: PumpSwap on-chain liquidity fix
description: PumpSwap pool accounts are keypair-based (not PDAs) — PDA derivation fails; use DexScreener pairAddress directly.
---

## Rule
When fetching on-chain liquidity for PumpSwap tokens, do NOT attempt PDA derivation from the mint.
Use the `pairAddress` field from the DexScreener API response as the pool account address directly.

## Why
PumpSwap pool accounts are keypair-generated (not program-derived addresses).
Deriving `findProgramAddressSync(['pool', idx, mint, wsolMint], pumpswapProgramId)` produces
the wrong address for every index tried (0–4 all return 404). Only the DexScreener `pairAddress`
field reliably identifies the actual on-chain pool account.

Proof-tested on token SOLY (DqBjJEh6nppACX8fvuXvyWx8AQddPd5na7k2LCFWpump):
- PDA derivation at index 0: `29qtadaj5C8e9jd8WMVVBEqjLD53S7R11rmqr6bqqHS3` → 404 from RPC
- DexScreener pairAddress: `CjXkWvUta3RGYsMBw74EhXU419HTKBD6Cgd7xVZnJ65p` → pool account found (203+ bytes)
- WSOL vault at offset 171: `Sr7XBqwZH1KRCmMoBPs9BasJgBcid3xZkJkVbhK3FPQ` → 176.63 SOL = $12,136 ✅

## Pool account layout (confirmed)
Byte offset 171 = pool_quote_token_account = WSOL vault:
  [0-7]   discriminator (8)
  [8]     pool_bump     (1)
  [9-10]  index         (2)
  [11-42] creator       (32)
  [43-74] base_mint     (32)
  [75-106] quote_mint   (32)
  [107-138] lp_mint     (32)
  [139-170] pool_base_token_account (32)
  [171-202] pool_quote_token_account = WSOL vault ← target

Account must be ≥203 bytes.

## Four-layer liquidity fallback (entry pipeline)

Applied in `collectQualityData` (token-quality.service.ts):

1. `initialSolReserves` — passed from `fetchReservesWithRetry` in processGraduation; sourced
   from `fetchOnChainPoolReserves(wsolVaultPubkey, tokenVaultPubkey)` or `fetchOnChainPoolSol(wsolVaultPubkey)`
   when only the WSOL vault is known (tokenVaultPubkey may be null due to ALT issues).
2. `onChainSolRaw` — `fetchOnChainSolBalance(wsolVaultPubkey)` called in parallel via Promise.all;
   tries Helius then public RPC; works even when initialSolReserves=0.
3. `pairAddressSol` — sequential fallback AFTER the 60s quality window; calls `fetchSolFromPairAddress(pairAddress)`:
   getAccountInfo(pairAddress) → buf[171:203] = wsolVaultKey → getTokenAccountBalance(wsolVaultKey).
   Only fires when both layers above return 0 AND dexResult.pairAddress is available.
4. DexScreener estimate — `dexResult.liquidityUsd / 150`; last resort, often 0 for fresh tokens.

## CRITICAL: tokenVaultPubkey can be null for PumpSwap
`fetchReservesWithRetry` previously required BOTH `wsolVaultPubkey` AND `tokenVaultPubkey` and
returned null early if either was null. Fixed: now only requires `wsolVaultPubkey`. When
`tokenVaultPubkey` is absent, calls `fetchOnChainPoolSol(wsolVaultPubkey)` which returns a
partial reserves object `{ solBalance, tokenBalanceUi: 0, price: 0 }` — enough for liquidity gate.

## `fetchOnChainPoolSol` RPC fallback
Was gated on `HELIUS_API_KEY` (returns null if absent). Fixed: tries Helius → api.mainnet-beta.solana.com
→ solana-mainnet.g.alchemy.com/v2/demo in order. Works in paper mode on Replit (no Helius).

## Position monitoring path (graduation-sniper.service.ts)
`fetchBatchedPrices` and `fetchPrice` both extract `pairAddress` from DexScreener response,
cache as `pumpswapVaultCache.set('pair:' + mint, pairAddress)`, then call
`fetchPumpSwapLiquidityUsd(poolAddress, solUsd)` when `liquidityUsd === 0`.
First param is the POOL address (not mint). Cache is keyed by poolAddress, NOT mint.

## On-chain vs DexScreener difference
On-chain reads only the WSOL (SOL) vault side = ~50% of DexScreener's `liquidity.usd`
(which counts both base token + quote token sides). This is correct and expected —
the SOL vault reserve is the authoritative metric for rug detection.
