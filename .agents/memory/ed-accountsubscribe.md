---
name: ED accountSubscribe pattern
description: How to use Helius WebSocket accountSubscribe for real-time per-token bonding curve updates alongside logsSubscribe
---

# Pattern

Helius WS supports both `logsSubscribe` and `accountSubscribe` on the same connection.

## Subscription lifecycle

1. On WS open: send `logsSubscribe` (id=1) for pump.fun program logs. Also subscribe to bonding curve PDAs for all currently tracked tokens.
2. When a new token arrives: call `subscribeBondingCurveAccount(mint)` immediately if WS is open.
3. Helius replies `{ id: <reqId>, result: <subscriptionId> }` to confirm — swap the temp reqId→mint mapping to subscriptionId→mint.
4. Incoming `accountNotification` messages: look up mint by subscriptionId, parse base64 account data, read virtualSolReserves at byte offset 32 (BigUInt64LE), graduation flag at byte 48.

## Key data maps

```typescript
bcSubIdToMint: Map<number, string>  // subscriptionId (or temp reqId) → mint
bcMintToSubId: Map<string, number>  // mint → confirmed subscriptionId
wsReqId: number                      // incrementing counter, start at 10 (1 is logsSubscribe)
```

## Distinguish logsSubscribe from accountSubscribe confirmations

The logsSubscribe uses `id: 1`. All accountSubscribe requests use `id > 1`. Check `reqId > 1` before treating a confirmation as an accountSubscribe.

## Bonding curve formula

```typescript
const virtualSolReserves = data.readBigUInt64LE(32);   // byte offset 32
const complete = data[48] === 1;                        // byte offset 48
const gradPct = complete ? 100 : Number(virtualSolReserves * 100n / 85_000_000_000n);
```

## Cleanup

On token prune: send `accountUnsubscribe` and delete from both maps. Prevents leaking subscriptions for dead tokens.

**Why:** accountSubscribe gives millisecond-latency BC updates vs 20s batch poll. Critical for catching graduation events early.
