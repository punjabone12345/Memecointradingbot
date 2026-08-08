---
name: Helius RPC shared rate limiter
description: Prevents continuous 429s when multiple independent services hit the same Helius API key
---

Multiple backend services (trenches.service.ts, whale-sniper.service.ts, helius-ws.service.ts)
each independently create their own Solana `Connection`/WebSocket to Helius and each had their
own local backoff. When any one service got rate-limited, the others kept firing at full speed,
so the aggregate request rate against the shared Helius key never actually dropped — this caused
a continuous stream of 429s in production (Render) and, downstream, a scanner/UI that appeared to
stop updating because every RPC call kept failing.

**Fix:** `artifacts/api-server/src/lib/helius-limiter.ts` centralizes ALL Helius RPC calls behind:
- A shared token-bucket (`HELIUS_MAX_RPS`, default 5/sec) + concurrency cap (`HELIUS_MAX_CONCURRENT`, default 3).
- A GLOBAL cooldown: a 429 from ANY service pauses ALL Helius calls process-wide, exponential backoff
  5s → 120s, reset on next success.

All three services now wrap their `getSignaturesForAddress`/`getParsedTransaction` calls in
`withHeliusLimit(() => ...)` and early-exit via `isHeliusCoolingDown()` before starting work.

**Why:** per-service backoff doesn't work when multiple services share one rate-limited resource —
only a process-wide shared limiter can actually reduce the aggregate request rate.

**How to apply:** any new service that calls Helius RPC directly must also route through
`withHeliusLimit`/`isHeliusCoolingDown` from `helius-limiter.ts`, or it will reintroduce the same
429 storm.
