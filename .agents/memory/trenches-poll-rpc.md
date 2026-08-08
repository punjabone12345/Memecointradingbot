---
name: Trenches poll Helius 429 / public RPC fallback
description: Why the migration-wallet getSignaturesForAddress poll fails on Render and how to keep it working despite Helius credit exhaustion.
---

## Problem
`@solana/web3.js` `Connection.getSignaturesForAddress` on the migration wallet fails consistently on Render when Helius returns `429 max usage reached`. The whale sniper's 2s polling consumes all available Helius free-tier credits, leaving nothing for the trenches poll.

## Fix
Replace `Connection.getSignaturesForAddress` with a direct `fetch()` call (`rpcGetSignatures`) and add a public RPC fallback:

1. Try primary endpoint (Helius or `RPC_ENDPOINT` env var).
2. On 429 / `max usage` error, retry with `https://api.mainnet-beta.solana.com`.
3. For non-429 errors, propagate normally.

The migration wallet poll is 1 call every 5s on a single well-known address — well within public RPC capacity.

## withHeliusLimit wrapping
`rpcGetSignatures` must be called inside `withHeliusLimit()` so 429 responses trigger the shared global cooldown and pause other services too. The fallback to public RPC happens *inside* `rpcGetSignatures` before the error propagates to `withHeliusLimit`.

## Why direct fetch() instead of Connection
The `@solana/web3.js` Connection object was observed to consistently fail on Render (7 straight poll failures, never bootstrapping) while `fetch()` to the same endpoint succeeds. Root cause unclear — possibly Connection initialization or keep-alive behaviour.

**Why:** `getSignaturesForAddress` using the whale sniper's HTTP call path (same `withHeliusLimit`) works fine for token mints but fails for the migration wallet — possibly due to the wallet's extremely high transaction volume triggering Helius account-level rate limits.

## Diagnostic endpoint
`GET /api/debug` → `poll.lastError` shows the exact exception message from the last failed poll cycle. This was critical for diagnosing the 429 root cause.
