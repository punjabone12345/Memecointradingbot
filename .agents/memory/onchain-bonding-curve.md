---
name: On-chain bonding curve reader
description: How we read pump.fun bonding curve graduation% directly from Solana mainnet RPC without any Solana SDK.
---

## The rule
Derive PDA via SHA256(b"bonding-curve" || mintBytes || nonce || programIdBytes || b"ProgramDerivedAddress"), nonce from 255 down, pick first hash that is NOT a valid Ed25519 point. Read via `getMultipleAccounts` (100 per batch). Parse `realSolReserves` at byte offset 32 (u64 LE), `complete` bool at byte 48.

**Why:** DexScreener graduation% lags by minutes and rounds. On-chain gives exact, real-time data matching Photon/BullX.

**How to apply:**
- `computeBondingCurvePda(mint)` — cached after first compute, uses only Node.js `crypto.createHash("sha256")`, no web3.js
- `refreshOnChainBondingCurves()` — fires 10s after start, then every 20s; skips if no tracked tokens
- graduation% = `realSolReserves / 85_000_000_000n * 100`; `complete=true` → 100%
- Use Helius RPC if `HELIUS_API_KEY` env is set, otherwise falls back to `https://api.mainnet-beta.solana.com`
- Confirmed working in production: logs show `on-chain bonding curves refreshed ⛓️ updated: 2, rpc: "public"`
