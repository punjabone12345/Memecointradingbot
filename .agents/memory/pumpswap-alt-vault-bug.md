---
name: PumpSwap ALT vault extraction bug
description: PumpSwap graduation TXs are v0 versioned transactions using Address Lookup Tables; vault pubkeys can only be resolved by merging loadedAddresses into accountKeys.
---

# PumpSwap ALT vault extraction — liquiditySol always 0

## The rule
Before indexing into `accountKeys` using `accountIndex` from `preTokenBalances`/`postTokenBalances`, always build a full merged list:
```typescript
const accountKeys = [
  ...staticAccountKeys,
  ...(meta.loadedAddresses?.writable ?? []).map(p => ({ pubkey: p })),
  ...(meta.loadedAddresses?.readonly ?? []).map(p => ({ pubkey: p })),
];
```

**Why:** PumpSwap graduation TXs are v0 versioned transactions that use Address Lookup Tables (ALTs). The `accountIndex` in token balance entries spans the FULL account list (static + ALT-resolved writable + ALT-resolved readonly). Without merging, any vault whose `accountIndex >= staticAccountKeys.length` resolves to `undefined` → `wsolVaultPubkey = null` → `fetchReservesWithRetry` returns null immediately → `initialPoolSol = 0` → `liquiditySol = 0` → quality gate skips every token.

**How to apply:** In `extractMintFromTx` in `graduation-sniper.service.ts`, anywhere `getTransaction` is called and the response's token balance `accountIndex` is used to look up a pubkey. The type definition also needs `loadedAddresses?: { writable?: string[]; readonly?: string[] }` added to `meta`.

## Symptom
- Helius key is set and working (buyer count, holder data both collected correctly)
- `wsolVaultPubkey` logged as `null` or vault pubkey not found
- Every token gets `liquiditySol = 0` → skip reason "Liquidity 0.0 SOL < 25 SOL minimum"
- DexScreener fallback also fails because 45s polling window is too short for new pools
